import { CfnOutput, CfnParameter, Duration, Fn, RemovalPolicy, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { createCanaryService } from './canary-service';
import type { BridgeMissingData, EcsCanarySpikeConfig } from './spike-config';

/** Prefix for explicit alarm names, so operators can force them by name. */
export const ALARM_NAME_PREFIX = 'EcsCanarySpike';
export const CONTAINER_NAME = 'fixture';
export const CONTAINER_PORT = 8080;
export const BRIDGE_METRIC_NAMESPACE = 'EcsCanarySpike';
export const BRIDGE_METRIC_NAME = 'WatchVerdict';

/** Matches `sha256:` followed by exactly 64 lowercase hexadecimal characters. */
export const IMAGE_DIGEST_PATTERN = '^sha256:[0-9a-f]{64}$';

export interface EcsCanarySpikeServiceStackProps extends StackProps {
  readonly config: EcsCanarySpikeConfig;
  readonly repository: ecr.IRepository;
}

const TREAT_MISSING_DATA: Record<BridgeMissingData, cloudwatch.TreatMissingData> = {
  notBreaching: cloudwatch.TreatMissingData.NOT_BREACHING,
  breaching: cloudwatch.TreatMissingData.BREACHING,
  missing: cloudwatch.TreatMissingData.MISSING,
};

/**
 * Disposable ECS-native canary target for spike S1 (infra#100).
 *
 * One Fargate service behind an ALB with two target groups and a production
 * listener rule, plus the alarms ECS watches during each deployment.
 */
export class EcsCanarySpikeServiceStack extends Stack {
  // Same approach as MovieReservationWorkloadStack: avoid an AZ context lookup
  // so synth stays offline (`--no-lookups`). CloudFormation selects two real
  // AZs of the account at deploy time; an ALB needs subnets in two AZs.
  public override get availabilityZones(): string[] {
    return [Fn.select(0, Fn.getAzs(this.region)), Fn.select(1, Fn.getAzs(this.region))];
  }

  public constructor(scope: Construct, id: string, props: EcsCanarySpikeServiceStackProps) {
    super(scope, id, props);
    const { config } = props;

    Tags.of(this).add('Project', 'movie-platform-infra');
    Tags.of(this).add('Spike', 'infra-100');
    Tags.of(this).add('Lifecycle', 'disposable');
    Tags.of(this).add('ExpiresOn', config.expiresOn);

    // The digest is a parameter so fault runs change only this value with
    // `update-stack --use-previous-template`, as a delivery pipeline would.
    const imageDigest = new CfnParameter(this, 'ImageDigest', {
      type: 'String',
      allowedPattern: IMAGE_DIGEST_PATTERN,
      description: 'Fixture image digest in the spike repository (sha256:<64 hex>)',
    });

    // Public subnets only and no NAT: tasks pull from ECR through the
    // internet gateway. Deployment semantics do not depend on network shape.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });
    const publicSubnets: ec2.SubnetSelection = { subnetType: ec2.SubnetType.PUBLIC };

    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      allowAllOutbound: false,
      description: 'Spike ALB: HTTP from the operator prefix list only',
    });
    albSecurityGroup.addIngressRule(
      ec2.Peer.prefixList(config.allowedIngressPrefixListId),
      ec2.Port.tcp(80),
      'Operator prefix list',
    );
    const taskSecurityGroup = new ec2.SecurityGroup(this, 'TaskSecurityGroup', {
      vpc,
      allowAllOutbound: true,
      description: 'Spike tasks: container port from the ALB only',
    });
    taskSecurityGroup.addIngressRule(albSecurityGroup, ec2.Port.tcp(CONTAINER_PORT), 'ALB to tasks');
    albSecurityGroup.addEgressRule(taskSecurityGroup, ec2.Port.tcp(CONTAINER_PORT), 'ALB to tasks');

    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
      vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      vpcSubnets: publicSubnets,
    });
    // ECS-native canary needs a listener *rule* to rewrite, so the default
    // action is a fixed 404 and production traffic goes through the rule.
    const listener = loadBalancer.addListener('HttpListener', {
      port: 80,
      open: false,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'no route',
      }),
    });

    const blueTargetGroup = this.fixtureTargetGroup('BlueTargetGroup', vpc);
    const greenTargetGroup = this.fixtureTargetGroup('GreenTargetGroup', vpc);
    const productionListenerRule = new elbv2.ApplicationListenerRule(this, 'ProductionListenerRule', {
      listener,
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/*'])],
      action: elbv2.ListenerAction.forward([blueTargetGroup]),
    });

    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });
    const containerLogGroup = new logs.LogGroup(this, 'ContainerLogGroup', {
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      cpu: 256,
      memoryLimitMiB: 512,
    });
    taskDefinition.addContainer(CONTAINER_NAME, {
      image: ecs.ContainerImage.fromRegistry(
        `${props.repository.repositoryUri}@${imageDigest.valueAsString}`,
      ),
      portMappings: [{ containerPort: CONTAINER_PORT }],
      logging: ecs.LogDrivers.awsLogs({ logGroup: containerLogGroup, streamPrefix: 'fixture' }),
    });
    props.repository.grantPull(taskDefinition.obtainExecutionRole());

    const alarms = this.deploymentAlarms(loadBalancer, config.bridgeMissingData);
    const deploymentAlarmNames = config.deploymentAlarmSet === 'all'
      ? [alarms.errorRate.alarmName, alarms.watchVerdict.alarmName, alarms.rollbackComposite.alarmName]
      : [alarms.errorRate.alarmName, alarms.watchVerdict.alarmName];

    const service = createCanaryService(this, 'Service', {
      cluster,
      taskDefinition,
      containerName: CONTAINER_NAME,
      containerPort: CONTAINER_PORT,
      vpcSubnets: publicSubnets,
      securityGroup: taskSecurityGroup,
      profile: config.profile,
      deploymentAlarmNames,
      blueTargetGroup,
      greenTargetGroup,
      productionListenerRule,
    });

    // ECS's own deployment events give authoritative timestamps for each run.
    const ecsEventsLogGroup = new logs.LogGroup(this, 'EcsEventsLogGroup', {
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    new events.Rule(this, 'EcsDeploymentEventsRule', {
      eventPattern: {
        source: ['aws.ecs'],
        detailType: ['ECS Deployment State Change', 'ECS Service Action'],
        resources: [service.serviceArn],
      },
      // The log-group resource policy calls a long-standing API, so the
      // built-in Lambda SDK is enough; no SDK install at deploy time.
      targets: [new targets.CloudWatchLogGroup(ecsEventsLogGroup, { installLatestAwsSdk: false })],
    });

    new CfnOutput(this, 'LoadBalancerDnsName', { value: loadBalancer.loadBalancerDnsName });
    new CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new CfnOutput(this, 'ServiceName', { value: service.serviceName });
    new CfnOutput(this, 'ProductionListenerRuleArn', { value: productionListenerRule.listenerRuleArn });
    new CfnOutput(this, 'BlueTargetGroupArn', { value: blueTargetGroup.targetGroupArn });
    new CfnOutput(this, 'GreenTargetGroupArn', { value: greenTargetGroup.targetGroupArn });
    new CfnOutput(this, 'EcsEventsLogGroupName', { value: ecsEventsLogGroup.logGroupName });
  }

  private fixtureTargetGroup(id: string, vpc: ec2.IVpc): elbv2.ApplicationTargetGroup {
    return new elbv2.ApplicationTargetGroup(this, id, {
      vpc,
      targetType: elbv2.TargetType.IP,
      protocol: elbv2.ApplicationProtocol.HTTP,
      port: CONTAINER_PORT,
      deregistrationDelay: Duration.seconds(10),
      healthCheck: {
        path: '/healthz',
        interval: Duration.seconds(10),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
      },
    });
  }

  /**
   * The three alarms ECS can watch. Explicit names let the runbook force
   * them with `aws cloudwatch set-alarm-state`; the stack is a singleton.
   */
  private deploymentAlarms(
    loadBalancer: elbv2.ApplicationLoadBalancer,
    bridgeMissingData: BridgeMissingData,
  ): {
    errorRate: cloudwatch.Alarm;
    watchVerdict: cloudwatch.Alarm;
    rollbackComposite: cloudwatch.CompositeAlarm;
  } {
    // Load-balancer level on purpose: canary target groups swap roles on
    // every deployment, so a per-target-group alarm would watch the wrong
    // revision half of the time.
    const errorRatePercent = new cloudwatch.MathExpression({
      expression: 'IF(requests > 0, 100 * errors / requests, 0)',
      usingMetrics: {
        errors: loadBalancer.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
          statistic: 'Sum',
        }),
        requests: loadBalancer.metrics.requestCount({ statistic: 'Sum' }),
      },
      period: Duration.minutes(1),
      label: 'Target 5xx percent',
    });
    const errorRate = errorRatePercent.createAlarm(this, 'ErrorRateAlarm', {
      alarmName: `${ALARM_NAME_PREFIX}-ErrorRate`,
      alarmDescription: 'Spike: target 5xx above 2% of requests',
      threshold: 2,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Models the D8 watch-verdict bridge and doubles as a sticky,
    // deterministic fault lever (`put-metric-data ... --value 1`).
    const watchVerdict = new cloudwatch.Metric({
      namespace: BRIDGE_METRIC_NAMESPACE,
      metricName: BRIDGE_METRIC_NAME,
      statistic: 'Maximum',
      period: Duration.seconds(10),
    }).createAlarm(this, 'WatchVerdictAlarm', {
      alarmName: `${ALARM_NAME_PREFIX}-WatchVerdict`,
      alarmDescription: 'Spike: watch-verdict bridge (1 = halt)',
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TREAT_MISSING_DATA[bridgeMissingData],
    });

    const rollbackComposite = new cloudwatch.CompositeAlarm(this, 'RollbackCompositeAlarm', {
      compositeAlarmName: `${ALARM_NAME_PREFIX}-Rollback`,
      alarmDescription: 'Spike: component rollback composite (anyOf members)',
      alarmRule: cloudwatch.AlarmRule.anyOf(
        cloudwatch.AlarmRule.fromAlarm(errorRate, cloudwatch.AlarmState.ALARM),
        cloudwatch.AlarmRule.fromAlarm(watchVerdict, cloudwatch.AlarmState.ALARM),
      ),
    });

    return { errorRate, watchVerdict, rollbackComposite };
  }
}
