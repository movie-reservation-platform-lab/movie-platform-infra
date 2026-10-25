import {
  SANDBOX_CASE_IDS,
  SANDBOX_PROBE_METRIC,
  SANDBOX_STEP_IDS,
  SandboxStepId,
  sandboxTaskFamily,
  sandboxTaskDefinitionOutputKey,
} from '@movie-platform/experiment-sandbox';
import {
  Annotations,
  Aspects,
  CfnOutput,
  CfnResource,
  CustomResource,
  Duration,
  IAspect,
  Stack,
  StackProps,
  Tags,
} from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import { Construct, IConstruct } from 'constructs';

import { SandboxConfig, SandboxResourceNames, sandboxResourceNames } from './config';
import { ExperimentControlStack } from './control-stack';
import {
  ECS_TASKS_PRINCIPAL,
  grantDeploymentObserverAccess,
  grantReleaseAccess,
  grantWatchAccess,
  TrialPermissionScope,
} from './workload-permissions';

/** Port the recommendation container listens on and the target groups forward to. */
const APP_PORT = 8082;
const APP_CONTAINER_NAME = 'recommendation';
const ECS_TASK_EXECUTION_POLICY = 'service-role/AmazonECSTaskExecutionRolePolicy';

/** The VPC, its public subnets, and the three security groups traffic passes through. */
interface WorkloadNetwork {
  readonly vpc: ec2.Vpc;
  readonly publicSubnets: ec2.SubnetSelection;
  /** The load balancer: reachable only from the operator addresses. */
  readonly albSecurityGroup: ec2.SecurityGroup;
  /** Recommendation tasks: reachable from the load balancer and the trial tools. */
  readonly taskSecurityGroup: ec2.SecurityGroup;
  /** Trial tasks and the delegate, which probe service tasks directly. */
  readonly toolSecurityGroup: ec2.SecurityGroup;
}

/** The load balancer and the blue/green routing ECS switches during a canary. */
interface CanaryRouting {
  readonly alb: elb.ApplicationLoadBalancer;
  readonly blueTargetGroup: elb.ApplicationTargetGroup;
  readonly greenTargetGroup: elb.ApplicationTargetGroup;
  /** The listener rule ECS moves between blue and green. */
  readonly productionRule: elb.ApplicationListenerRule;
}

/** Every IAM role the workload's tasks run with. */
interface WorkloadRoles {
  /** Pulls images and writes logs for every task. */
  readonly execution: iam.Role;
  /** The recommendation service's task role; it has no permissions. */
  readonly workload: iam.Role;
  readonly gate: iam.Role;
  readonly watch: iam.Role;
  readonly release: iam.Role;
  /** May only invoke the control stack's launcher. */
  readonly delegate: iam.Role;
}

/** The recommendation service and what the trial steps need to know about it. */
interface RecommendationService {
  readonly service: ecs.FargateService;
  /** The baseline task definition; releases register new revisions of its family. */
  readonly recipe: ecs.FargateTaskDefinition;
  /** Rolls a canary back when the watch step reports probe failures, or goes silent. */
  readonly probeAlarm: cloudwatch.Alarm;
}

interface DelegateInputs {
  readonly config: SandboxConfig;
  readonly names: SandboxResourceNames;
  readonly control: ExperimentControlStack;
  readonly cluster: ecs.ICluster;
  readonly logGroup: logs.ILogGroup;
  readonly taskRole: iam.IRole;
  readonly securityGroup: ec2.ISecurityGroup;
  readonly vpcSubnets: ec2.SubnetSelection;
}

/** What the recommendation service is built from. */
interface RecommendationServiceParts {
  readonly config: SandboxConfig;
  readonly names: SandboxResourceNames;
  readonly network: WorkloadNetwork;
  readonly routing: CanaryRouting;
  readonly cluster: ecs.Cluster;
  readonly roles: WorkloadRoles;
  readonly logGroup: logs.ILogGroup;
}

/** What the trial-step grants are scoped to. */
interface TrialStepAccessParts {
  readonly config: SandboxConfig;
  readonly names: SandboxResourceNames;
  readonly control: ExperimentControlStack;
  readonly cluster: ecs.Cluster;
  readonly roles: WorkloadRoles;
  readonly recommendation: RecommendationService;
}

/** What the nine trial task definitions are built from. */
interface TrialTaskDefinitionParts {
  readonly config: SandboxConfig;
  readonly control: ExperimentControlStack;
  readonly cluster: ecs.Cluster;
  readonly roles: WorkloadRoles;
  readonly logGroup: logs.ILogGroup;
  readonly recommendation: RecommendationService;
}

/** What {@link ExperimentWorkloadStack} publishes as stack outputs. */
interface WorkloadOutputParts {
  readonly network: WorkloadNetwork;
  readonly routing: CanaryRouting;
  readonly cluster: ecs.Cluster;
  readonly recommendation: RecommendationService;
  readonly trialTaskDefinitionArns: Record<string, string>;
}

/**
 * Disposable workload for one canary experiment: a public VPC, an ALB with
 * blue/green target groups, the recommendation service using native ECS canary
 * deployments, the gate/watch/release trial tasks, and a Harness delegate.
 *
 * Every resource waits for the control stack's admission check, so nothing is
 * allocated unless the experiment lease is valid. Trial-step IAM lives in
 * `workload-permissions.ts`.
 */
export class ExperimentWorkloadStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    config: SandboxConfig,
    control: ExperimentControlStack,
    props: StackProps = {},
  ) {
    super(scope, id, props);

    const names = sandboxResourceNames(config);

    Tags.of(this).add('ExperimentId', config.experimentId);

    this.requireAdmission(config, control);

    const network = this.createNetwork(config);
    const routing = this.createCanaryRouting(config, network);

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: network.vpc,
      clusterName: names.cluster,
    });

    const roles = this.createRoles(names);
    // Task logs live in the control stack so they outlive automatic cleanup.
    const logGroup = control.taskLogGroup;

    const recommendation = this.createRecommendationService({
      config,
      names,
      network,
      routing,
      cluster,
      roles,
      logGroup,
    });

    this.grantTrialStepAccess({ config, names, control, cluster, roles, recommendation });

    const trialTaskDefinitionArns = this.createTrialTaskDefinitions({
      config,
      control,
      cluster,
      roles,
      logGroup,
      recommendation,
    });

    this.createDelegate({
      config,
      names,
      control,
      cluster,
      logGroup,
      taskRole: roles.delegate,
      securityGroup: network.toolSecurityGroup,
      vpcSubnets: network.publicSubnets,
    });

    this.exportOutputs({ network, routing, cluster, recommendation, trialTaskDefinitionArns });
  }

  /**
   * Adds the admission custom resource and makes every other resource wait for it,
   * so nothing is allocated unless the control stack confirms a valid lease.
   */
  private requireAdmission(config: SandboxConfig, control: ExperimentControlStack): void {
    const admission = new CustomResource(this, 'ProtectedAdmission', {
      serviceToken: control.admissionProvider.serviceToken,
      properties: { ExperimentId: config.experimentId },
    });

    Aspects.of(this).add(new DependOnAdmission(admission));
  }

  /**
   * Public subnets only and no NAT gateways: cheap and disposable. Ingress is
   * limited to the operator addresses from the config.
   */
  private createNetwork(config: SandboxConfig): WorkloadNetwork {
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
      restrictDefaultSecurityGroup: false,
    });

    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      allowAllOutbound: false,
    });

    for (const cidr of config.allowedIngressCidrs) {
      albSecurityGroup.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(80));
    }

    const taskSecurityGroup = new ec2.SecurityGroup(this, 'TaskSecurityGroup', {
      vpc,
      allowAllOutbound: true,
    });

    taskSecurityGroup.addIngressRule(albSecurityGroup, ec2.Port.tcp(APP_PORT));
    albSecurityGroup.addEgressRule(taskSecurityGroup, ec2.Port.tcp(APP_PORT));

    // Trial tasks probe service tasks directly, so a verdict can be tied to one task revision.
    const toolSecurityGroup = new ec2.SecurityGroup(this, 'ToolSecurityGroup', {
      vpc,
      allowAllOutbound: true,
    });

    taskSecurityGroup.addIngressRule(
      toolSecurityGroup,
      ec2.Port.tcp(APP_PORT),
      'Revision-attributed probes',
    );

    return {
      vpc,
      publicSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      albSecurityGroup,
      taskSecurityGroup,
      toolSecurityGroup,
    };
  }

  /**
   * The internet-facing load balancer with blue and green target groups. Traffic
   * starts on blue; during a canary ECS moves the production rule between the two.
   */
  private createCanaryRouting(config: SandboxConfig, network: WorkloadNetwork): CanaryRouting {
    const alb = new elb.ApplicationLoadBalancer(this, 'Alb', {
      vpc: network.vpc,
      loadBalancerName: `${config.experimentId}-alb`,
      internetFacing: true,
      securityGroup: network.albSecurityGroup,
      vpcSubnets: network.publicSubnets,
    });

    const listener = alb.addListener('Http', {
      port: 80,
      open: false,
      defaultAction: elb.ListenerAction.fixedResponse(404),
    });

    const blueTargetGroup = this.createTargetGroup(network.vpc, 'Blue', `${config.experimentId}-b`);

    const greenTargetGroup = this.createTargetGroup(
      network.vpc,
      'Green',
      `${config.experimentId}-g`,
    );

    const productionRule = new elb.ApplicationListenerRule(this, 'ProductionRule', {
      listener,
      priority: 10,
      conditions: [elb.ListenerCondition.pathPatterns(['/*'])],
      action: elb.ListenerAction.forward([blueTargetGroup]),
    });

    return { alb, blueTargetGroup, greenTargetGroup, productionRule };
  }

  /** One IP target group on the app port, health-checked on `/ready`. */
  private createTargetGroup(
    vpc: ec2.IVpc,
    constructId: string,
    targetGroupName: string,
  ): elb.ApplicationTargetGroup {
    return new elb.ApplicationTargetGroup(this, constructId, {
      vpc,
      port: APP_PORT,
      protocol: elb.ApplicationProtocol.HTTP,
      targetType: elb.TargetType.IP,
      targetGroupName,
      healthCheck: { path: '/ready', interval: Duration.seconds(15), healthyThresholdCount: 2 },
      deregistrationDelay: Duration.seconds(10),
    });
  }

  /** The shared execution role and one task role per job; permissions are granted later. */
  private createRoles(names: SandboxResourceNames): WorkloadRoles {
    const execution = new iam.Role(this, 'ExecutionRole', {
      roleName: names.roles.execution,
      assumedBy: new iam.ServicePrincipal(ECS_TASKS_PRINCIPAL),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName(ECS_TASK_EXECUTION_POLICY)],
    });

    return {
      execution,
      workload: this.createTaskRole('workloadRole', names.roles.workload),
      gate: this.createTaskRole('gateRole', names.roles.gate),
      watch: this.createTaskRole('watchRole', names.roles.watch),
      release: this.createTaskRole('releaseRole', names.roles.release),
      delegate: this.createTaskRole('delegateRole', names.roles.delegate),
    };
  }

  /** A role that only ECS tasks can assume, with no permissions yet. */
  private createTaskRole(constructId: string, roleName: string): iam.Role {
    return new iam.Role(this, constructId, {
      roleName,
      assumedBy: new iam.ServicePrincipal(ECS_TASKS_PRINCIPAL),
    });
  }

  /**
   * The recommendation service, released through a native ECS canary: 10% of traffic
   * for five minutes, then a five-minute bake, rolled back if the probe alarm fires.
   */
  private createRecommendationService(parts: RecommendationServiceParts): RecommendationService {
    const { config, names, network, routing, cluster, roles, logGroup } = parts;

    // The "recipe" is the baseline task definition. The release step registers
    // new revisions of this family with a different image.
    const recipe = new ecs.FargateTaskDefinition(this, 'RecommendationRecipe', {
      family: names.recommendationTaskFamily,
      cpu: 256,
      memoryLimitMiB: 512,
      taskRole: roles.workload,
      executionRole: roles.execution,
    });

    recipe.addContainer(APP_CONTAINER_NAME, {
      containerName: APP_CONTAINER_NAME,
      image: ecs.ContainerImage.fromRegistry(config.goodImage),
      portMappings: [{ containerPort: APP_PORT }],
      environment: { PORT: String(APP_PORT) },
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: APP_CONTAINER_NAME }),
    });

    const probeAlarm = this.createProbeAlarm(config);

    const service = new ecs.FargateService(this, 'RecommendationService', {
      cluster,
      serviceName: names.recommendationService,
      taskDefinition: recipe,
      desiredCount: 2,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      assignPublicIp: true,
      vpcSubnets: network.publicSubnets,
      securityGroups: [network.taskSecurityGroup],
      deploymentStrategy: ecs.DeploymentStrategy.CANARY,
      canaryConfiguration: { stepPercent: 10, stepBakeTime: Duration.minutes(5) },
      bakeTime: Duration.minutes(5),
      deploymentAlarms: {
        alarmNames: [probeAlarm.alarmName],
        behavior: ecs.AlarmBehavior.ROLLBACK_ON_ALARM,
      },
    });

    // The first healthy baseline is infrastructure setup, before a watcher exists.
    // The trusted release task arms these exact alarms only after fresh watcher
    // readiness and every configured alarm OK, in the same first UpdateService.
    (service.node.defaultChild as ecs.CfnService).addPropertyOverride(
      'DeploymentConfiguration.Alarms.Enable',
      false,
    );

    const loadBalancerTarget = service.loadBalancerTarget({
      containerName: APP_CONTAINER_NAME,
      containerPort: APP_PORT,
      alternateTarget: new ecs.AlternateTarget('Alternate', {
        alternateTargetGroup: routing.greenTargetGroup,
        productionListener: ecs.ListenerRuleConfiguration.applicationListenerRule(
          routing.productionRule,
        ),
      }),
    });

    loadBalancerTarget.attachToApplicationTargetGroup(routing.blueTargetGroup);

    Annotations.of(service).acknowledgeWarning(
      '@aws-cdk/aws-ecs:shouldUseCircuitBreaker',
      'Native canary uses deployment alarm rollback, preserving S1 behavior.',
    );

    return { service, recipe, probeAlarm };
  }

  /**
   * The deployment alarm fed by the watch step's probe metric. Missing data counts
   * as breaching, so a silent watcher rolls the deployment back.
   */
  private createProbeAlarm(config: SandboxConfig): cloudwatch.Alarm {
    return new cloudwatch.Alarm(this, 'ProbeAlarm', {
      alarmName: `${config.experimentId}-probe`,
      metric: new cloudwatch.Metric({
        namespace: SANDBOX_PROBE_METRIC.namespace,
        metricName: SANDBOX_PROBE_METRIC.metricName,
        dimensionsMap: { ExperimentId: config.experimentId },
        statistic: 'Maximum',
        period: Duration.seconds(10),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
  }

  /** Gives the watch and release roles their permissions; the gate role gets none. */
  private grantTrialStepAccess(parts: TrialStepAccessParts): void {
    const { config, names, control, cluster, roles, recommendation } = parts;

    const permissionScope: TrialPermissionScope = {
      stack: this,
      config,
      names,
      clusterArn: cluster.clusterArn,
      stateTableArn: control.state.tableArn,
      probeAlarmArn: recommendation.probeAlarm.alarmArn,
    };

    for (const role of [roles.watch, roles.release]) {
      grantDeploymentObserverAccess(role, permissionScope);
    }

    grantWatchAccess(roles.watch, permissionScope);
    grantReleaseAccess(roles.release, permissionScope, [roles.workload, roles.execution]);
  }

  /**
   * One task definition per case and step (nine in total), all running the trial
   * tools image. They share one runtime config; the command picks the case and step.
   *
   * @returns task definition ARNs keyed by their stack output name
   */
  private createTrialTaskDefinitions(parts: TrialTaskDefinitionParts): Record<string, string> {
    const { config, control, cluster, roles, logGroup, recommendation } = parts;

    const runtimeConfig = JSON.stringify({
      experimentId: config.experimentId,
      region: config.region,
      cluster: cluster.clusterArn,
      service: recommendation.service.serviceName,
      recipeTaskDefinitionArn: recommendation.recipe.taskDefinitionArn,
      containerName: APP_CONTAINER_NAME,
      goodImage: config.goodImage,
      badImage: config.badImage,
      stateTableName: control.state.tableName,
      probeAlarmName: recommendation.probeAlarm.alarmName,
    });

    const stepRoles: Record<SandboxStepId, iam.IRole> = {
      gate: roles.gate,
      watch: roles.watch,
      release: roles.release,
    };

    const taskDefinitionArns: Record<string, string> = {};

    for (const caseId of SANDBOX_CASE_IDS) {
      for (const stepId of SANDBOX_STEP_IDS) {
        const outputKey = sandboxTaskDefinitionOutputKey(caseId, stepId);
        const constructId = outputKey.replace(/TaskDefinitionArn$/, '');

        const taskDefinition = new ecs.FargateTaskDefinition(this, constructId, {
          family: sandboxTaskFamily(config.experimentId, caseId, stepId),
          cpu: 256,
          memoryLimitMiB: 512,
          taskRole: stepRoles[stepId],
          executionRole: roles.execution,
        });

        taskDefinition.addContainer('trial', {
          containerName: 'trial',
          image: ecs.ContainerImage.fromRegistry(config.toolsImage),
          command: ['task', stepId, '--case', caseId],
          environment: { TRIAL_RUNTIME_CONFIG: runtimeConfig },
          logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: `${caseId}-${stepId}` }),
        });

        taskDefinitionArns[outputKey] = taskDefinition.taskDefinitionArn;
      }
    }

    return taskDefinitionArns;
  }

  /**
   * Harness delegate: a long-running task that connects to Harness SaaS and
   * starts trial steps through the control stack's launcher Lambda.
   */
  private createDelegate(inputs: DelegateInputs): ecs.FargateService {
    const { config, names, control } = inputs;

    const executionRole = this.createTaskRole(
      'delegate-executionRole',
      names.roles.delegateExecution,
    );

    executionRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(ECS_TASK_EXECUTION_POLICY),
    );

    const token = secrets.Secret.fromSecretCompleteArn(
      this,
      'DelegateToken',
      config.delegateTokenSecretArn,
    );

    token.grantRead(executionRole);

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'DelegateTask', {
      family: names.delegateTaskFamily,
      cpu: 2048,
      memoryLimitMiB: 4096,
      taskRole: inputs.taskRole,
      executionRole,
    });

    taskDefinition.addContainer('delegate', {
      image: ecs.ContainerImage.fromRegistry(config.delegateImage),
      secrets: { DELEGATE_TOKEN: ecs.Secret.fromSecretsManager(token) },
      environment: {
        ACCOUNT_ID: config.harnessAccountId,
        MANAGER_HOST_AND_PORT: config.harnessManagerUrl,
        DELEGATE_NAME: config.experimentId,
        DELEGATE_TYPE: 'DOCKER',
        LAUNCHER_ARN: control.launcher.functionArn,
        EXPERIMENT_ID: config.experimentId,
        SANDBOX_ACCOUNT_ID: config.accountId,
        SANDBOX_REGION: config.region,
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup: inputs.logGroup, streamPrefix: 'delegate' }),
    });

    control.launcher.grantInvoke(inputs.taskRole);

    return new ecs.FargateService(this, 'DelegateService', {
      cluster: inputs.cluster,
      serviceName: names.delegateService,
      taskDefinition,
      desiredCount: 1,
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      assignPublicIp: true,
      vpcSubnets: inputs.vpcSubnets,
      securityGroups: [inputs.securityGroup],
      circuitBreaker: { rollback: true },
    });
  }

  /** Stack outputs the launcher and the trial tool read: task definitions, network, service. */
  private exportOutputs(parts: WorkloadOutputParts): void {
    const { network, routing, cluster, recommendation, trialTaskDefinitionArns } = parts;

    const outputs: Record<string, string> = {
      ...trialTaskDefinitionArns,
      ClusterArn: cluster.clusterArn,
      SubnetIds: network.vpc.publicSubnets.map((subnet) => subnet.subnetId).join(','),
      TaskSecurityGroupId: network.toolSecurityGroup.securityGroupId,
      ServiceName: recommendation.service.serviceName,
      RecipeTaskDefinitionArn: recommendation.recipe.taskDefinitionArn,
      ProbeAlarmName: recommendation.probeAlarm.alarmName,
      LoadBalancerDnsName: routing.alb.loadBalancerDnsName,
    };

    for (const [key, value] of Object.entries(outputs)) {
      new CfnOutput(this, key, { value });
    }
  }
}

/**
 * Makes every CloudFormation resource in the stack depend on the admission
 * custom resource, so nothing is created before the lease check passes.
 *
 * An Aspect runs at synth time over the whole construct tree, so resources
 * added anywhere in the stack, in any order, are covered automatically.
 */
class DependOnAdmission implements IAspect {
  private readonly admissionResource: CfnResource;

  constructor(admission: CustomResource) {
    this.admissionResource = admission.node.defaultChild as CfnResource;
  }

  visit(node: IConstruct): void {
    if (node instanceof CfnResource && node !== this.admissionResource) {
      node.addResourceDependency(this.admissionResource);
    }
  }
}
