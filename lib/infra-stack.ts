import * as path from 'node:path';

import * as cdk from 'aws-cdk-lib';
import * as aps from 'aws-cdk-lib/aws-aps';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as grafana from 'aws-cdk-lib/aws-grafana';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

import { resolveApplicationImage } from './application-image';
import type { PlatformConfig } from './config/platform-config';

const APP_CONTAINER_PORT = 3000;
const AMP_REMOTE_WRITE_ACTIONS = ['aps:RemoteWrite'];
const AMP_QUERY_ACTIONS = ['aps:GetLabels', 'aps:GetMetricMetadata', 'aps:GetSeries', 'aps:QueryMetrics'];
const CLOUDWATCH_METRIC_READ_ACTIONS = ['cloudwatch:GetMetricData', 'cloudwatch:ListMetrics'];
const STS_IDENTITY_ACTIONS = ['sts:GetCallerIdentity'];
const XRAY_WRITE_ACTIONS = ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'];
const RESERVATION_FAILURE_INJECTION_SALT = 'aws-demo-managed-observability';

/** Input required to synthesize the current demo infrastructure stack. */
export interface GoldenPathDemoStackProps extends cdk.StackProps {
  /** Validated platform settings resolved once at the CDK application boundary. */
  readonly platformConfig: PlatformConfig;
}

/**
 * Deployment the movie reservation platform.
 *
 * **Note**: This phase intentionally keeps the infrastructure in one CloudFormation
 * stack so the complete request path and its costs are easy to learn, deploy,
 * and tear down together.
 *
 * The stack provisions:
 * - a two-AZ VPC without a NAT gateway
 * - public subnets for a CIDR-restricted Application Load Balancer
 * - one selected isolated workload subnet for the Fargate service
 * - the S3, ECR, CloudWatch Logs, X-Ray, AMP, and STS endpoints required by private tasks
 * - an optional SSM Messages endpoint and task permissions for ECS Exec
 * - a disposable AMP workspace and enhanced ECS Container Insights
 * - a CIDR-restricted Managed Grafana workspace and customer-managed metric-read role
 * - the service and ADOT image assets, log groups, task definition, ECS service, and ALB
 * - common resource tags plus ALB, CloudWatch, ECS, AMP, and Grafana outputs
 *
 * The backend uses the in-memory demo composition and exports OTLP/HTTP traces
 * and metrics through a nonessential ADOT sidecar. ADOT sends traces to X-Ray
 * and fans application metrics out to CloudWatch through EMF and AMP through
 * Prometheus remote write. The same sidecar also exports bounded task/container
 * metrics to AMP. Later waves can split networking, workloads, and
 * observability into separate constructs or stacks when those ownership and
 * lifecycle boundaries become useful.
 */
export class GoldenPathDemoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GoldenPathDemoStackProps) {
    super(scope, id, props);

    const { platformConfig } = props;

    cdk.Tags.of(this).add('Project', 'golden-path-ecs-template');
    cdk.Tags.of(this).add('Platform', platformConfig.platformName);
    cdk.Tags.of(this).add('Environment', platformConfig.environmentName);

    const tagServiceResource = (resource: Construct) => {
      cdk.Tags.of(resource).add('Service', platformConfig.serviceName);
    };

    const vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${platformConfig.environmentName}-vpc`,
      maxAzs: platformConfig.vpcMaxAzs,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'workload',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    const workloadSubnets = vpc
      .selectSubnets({ subnetGroupName: 'workload' })
      .subnets.slice(0, platformConfig.workloadAzCount);

    if (workloadSubnets.length !== platformConfig.workloadAzCount) {
      throw new Error(`Expected ${platformConfig.workloadAzCount} workload subnet, found ${workloadSubnets.length}.`);
    }

    const workloadSubnetSelection: ec2.SubnetSelection = {
      subnets: workloadSubnets,
    };

    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      description: 'Allows restricted HTTP ingress to the public demo ALB',
    });
    tagServiceResource(albSecurityGroup);
    albSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(platformConfig.allowedIngressCidr),
      ec2.Port.tcp(80),
      'Demo HTTP access restricted by explicit source CIDR',
    );

    const serviceSecurityGroup = new ec2.SecurityGroup(this, 'ServiceSecurityGroup', {
      vpc,
      description: 'Allows ALB traffic to the private ECS tasks',
    });
    tagServiceResource(serviceSecurityGroup);
    serviceSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(APP_CONTAINER_PORT),
      'Only the ALB can call the application container',
    );

    const endpointSecurityGroup = new ec2.SecurityGroup(this, 'EndpointSecurityGroup', {
      vpc,
      description: 'Allows private ECS tasks to reach interface VPC endpoints',
    });
    endpointSecurityGroup.addIngressRule(
      serviceSecurityGroup,
      ec2.Port.tcp(443),
      'Private ECS tasks use HTTPS to AWS service endpoints',
    );

    const ampWorkspace = new aps.CfnWorkspace(this, 'AmpWorkspace', {
      alias: `${platformConfig.platformName}-${platformConfig.environmentName}`,
      workspaceConfiguration: {
        retentionPeriodInDays: 7,
      },
    });
    ampWorkspace.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    tagServiceResource(ampWorkspace);

    // The workspace ARN is deliberately wildcarded in the trust policy to
    // avoid a CloudFormation cycle: Grafana needs this role ARN while creating
    // the workspace. SourceAccount and the same-account workspace ARN pattern
    // still prevent another service or account from assuming the role.
    const grafanaWorkspaceSourceArn = cdk.Fn.join('', [
      'arn:',
      cdk.Aws.PARTITION,
      ':grafana:',
      cdk.Aws.REGION,
      ':',
      cdk.Aws.ACCOUNT_ID,
      ':/workspaces/*',
    ]);
    const grafanaDataAccessRole = new iam.Role(this, 'GrafanaDataAccessRole', {
      description: 'Allows the Managed Grafana workspace to query the demo AMP and CloudWatch metrics',
      assumedBy: new iam.ServicePrincipal('grafana.amazonaws.com', {
        conditions: {
          ArnLike: {
            'aws:SourceArn': grafanaWorkspaceSourceArn,
          },
          StringEquals: {
            'aws:SourceAccount': cdk.Aws.ACCOUNT_ID,
          },
        },
      }),
    });
    const grafanaDataAccessPolicy = new iam.Policy(this, 'GrafanaDataAccessPolicy', {
      roles: [grafanaDataAccessRole],
      statements: [
        new iam.PolicyStatement({
          actions: AMP_QUERY_ACTIONS,
          resources: [ampWorkspace.attrArn],
        }),
        new iam.PolicyStatement({
          // These metric discovery/query and Region discovery APIs do not
          // support useful resource-level scoping.
          actions: [...CLOUDWATCH_METRIC_READ_ACTIONS, 'ec2:DescribeRegions'],
          resources: ['*'],
        }),
      ],
    });

    const grafanaAccessPrefixList = new ec2.CfnPrefixList(this, 'GrafanaAccessPrefixList', {
      addressFamily: 'IPv4',
      entries: [
        {
          cidr: platformConfig.allowedIngressCidr,
          description: 'Trusted laptop CIDR for the disposable Grafana workspace',
        },
      ],
      maxEntries: 1,
      prefixListName: `${platformConfig.platformName}-${platformConfig.environmentName}-grafana-access`,
    });
    tagServiceResource(grafanaAccessPrefixList);

    const grafanaWorkspace = new grafana.CfnWorkspace(this, 'GrafanaWorkspace', {
      accountAccessType: 'CURRENT_ACCOUNT',
      authenticationProviders: ['AWS_SSO'],
      description: 'Managed metrics dashboard for the movie reservation AWS demo',
      name: `${platformConfig.platformName}-${platformConfig.environmentName}`,
      networkAccessControl: {
        prefixListIds: [grafanaAccessPrefixList.attrPrefixListId],
        vpceIds: [],
      },
      permissionType: 'CUSTOMER_MANAGED',
      roleArn: grafanaDataAccessRole.roleArn,
    });
    // roleArn creates a dependency on the role itself, not on its separately
    // synthesized AWS::IAM::Policy. Wait for both before Grafana validates and
    // starts using the customer-managed role.
    grafanaWorkspace.node.addDependency(grafanaDataAccessPolicy);
    grafanaWorkspace.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    tagServiceResource(grafanaWorkspace);

    vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [workloadSubnetSelection],
    });

    const interfaceEndpointProps = {
      subnets: workloadSubnetSelection,
      securityGroups: [endpointSecurityGroup],
      privateDnsEnabled: true,
      open: false,
    };

    vpc.addInterfaceEndpoint('EcrApiEndpoint', {
      ...interfaceEndpointProps,
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
    });
    vpc.addInterfaceEndpoint('EcrDockerEndpoint', {
      ...interfaceEndpointProps,
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
    });
    vpc.addInterfaceEndpoint('CloudWatchLogsEndpoint', {
      ...interfaceEndpointProps,
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
    });
    const xrayEndpoint = vpc.addInterfaceEndpoint('XRayEndpoint', {
      ...interfaceEndpointProps,
      service: ec2.InterfaceVpcEndpointAwsService.XRAY,
    });
    xrayEndpoint.addToPolicy(
      new iam.PolicyStatement({
        principals: [new iam.AnyPrincipal()],
        actions: XRAY_WRITE_ACTIONS,
        resources: ['*'],
      }),
    );
    const ampWorkspaceEndpoint = vpc.addInterfaceEndpoint('AmpWorkspaceEndpoint', {
      ...interfaceEndpointProps,
      service: ec2.InterfaceVpcEndpointAwsService.PROMETHEUS_WORKSPACES,
    });
    ampWorkspaceEndpoint.addToPolicy(
      new iam.PolicyStatement({
        principals: [new iam.AnyPrincipal()],
        actions: AMP_REMOTE_WRITE_ACTIONS,
        resources: [ampWorkspace.attrArn],
      }),
    );
    const stsEndpoint = vpc.addInterfaceEndpoint('StsEndpoint', {
      ...interfaceEndpointProps,
      service: ec2.InterfaceVpcEndpointAwsService.STS,
    });
    stsEndpoint.addToPolicy(
      new iam.PolicyStatement({
        principals: [new iam.AnyPrincipal()],
        actions: STS_IDENTITY_ACTIONS,
        resources: ['*'],
      }),
    );

    if (platformConfig.enableEcsExec) {
      vpc.addInterfaceEndpoint('SsmMessagesEndpoint', {
        ...interfaceEndpointProps,
        service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
      });
    }

    const clusterName = `${platformConfig.platformName}-${platformConfig.environmentName}`;
    const containerInsightsLogGroup = new logs.LogGroup(this, 'ContainerInsightsLogGroup', {
      logGroupName: `/aws/ecs/containerinsights/${clusterName}/performance`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const cluster = new ecs.Cluster(this, 'ApplicationCluster', {
      vpc,
      clusterName,
      containerInsightsV2: ecs.ContainerInsights.ENHANCED,
    });
    cluster.node.addDependency(containerInsightsLogGroup);

    const repositoryRoot = path.join(__dirname, '..', '..');
    const applicationImage = resolveApplicationImage(this);
    const adotImage = new ecrAssets.DockerImageAsset(this, 'AdotImage', {
      directory: path.join(repositoryRoot, 'ecs-infra', 'adot-collector'),
    });
    const cloudWatchApplicationMetricsNamespace =
      `GoldenPath/${platformConfig.environmentName}/${platformConfig.serviceName}`;

    const appLogGroup = new logs.LogGroup(this, 'AppLogGroup', {
      logGroupName: `/golden-path/${platformConfig.environmentName}/${platformConfig.serviceName}/app`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    tagServiceResource(appLogGroup);
    const adotLogGroup = new logs.LogGroup(this, 'AdotLogGroup', {
      logGroupName: `/golden-path/${platformConfig.environmentName}/${platformConfig.serviceName}/adot`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    tagServiceResource(adotLogGroup);
    const applicationMetricsLogGroup = new logs.LogGroup(this, 'ApplicationMetricsLogGroup', {
      logGroupName: `/golden-path/${platformConfig.environmentName}/${platformConfig.serviceName}/metrics`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    tagServiceResource(applicationMetricsLogGroup);

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      family: `${platformConfig.environmentName}-${platformConfig.serviceName}`,
      cpu: 512,
      memoryLimitMiB: 1024,
    });
    tagServiceResource(taskDefinition);

    // X-Ray write APIs do not support resource-scoped ARNs. ECS task roles are
    // task-wide, so the app and collector technically share these permissions.
    taskDefinition.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: XRAY_WRITE_ACTIONS,
        resources: ['*'],
      }),
    );
    taskDefinition.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: AMP_REMOTE_WRITE_ACTIONS,
        resources: [ampWorkspace.attrArn],
      }),
    );
    applicationMetricsLogGroup.grantWrite(taskDefinition.taskRole);

    if (platformConfig.enableEcsExec) {
      // ECS Exec message-channel actions do not support resource-scoped ARNs.
      taskDefinition.addToTaskRolePolicy(
        new iam.PolicyStatement({
          actions: [
            'ssmmessages:CreateControlChannel',
            'ssmmessages:CreateDataChannel',
            'ssmmessages:OpenControlChannel',
            'ssmmessages:OpenDataChannel',
          ],
          resources: ['*'],
        }),
      );
    }

    const appContainer = taskDefinition.addContainer('AppContainer', {
      containerName: platformConfig.serviceName,
      image: applicationImage.image,
      essential: true,
      cpu: 384,
      memoryLimitMiB: 640,
      logging: ecs.LogDrivers.awsLogs({
        logGroup: appLogGroup,
        streamPrefix: 'app',
      }),
      environment: {
        PORT: APP_CONTAINER_PORT.toString(),
        HOST: '0.0.0.0',
        NODE_ENV: 'development',
        LOG_LEVEL: 'info',
        SERVICE_VERSION: applicationImage.serviceVersion,
        COMPOSITION_PROFILE: 'local-fixed-user',
        RESERVATION_WORKER_MODE: 'fake-in-process',
        RESERVATION_FAILURE_INJECTION_MODE: 'stable-random-unexpected-error',
        RESERVATION_FAILURE_INJECTION_RATE: '0.4',
        RESERVATION_FAILURE_INJECTION_SALT,
        OBSERVABILITY_ENABLED: 'true',
        OTEL_SERVICE_NAME: platformConfig.serviceName,
        OTEL_TRACES_EXPORTER: 'otlp',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_METRIC_EXPORT_INTERVAL: (platformConfig.metricsExportIntervalSeconds * 1000).toString(),
        OTEL_LOGS_EXPORTER: 'none',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
        OTEL_PROPAGATORS: 'tracecontext,baggage',
        // Deterministic sample-all is for this low-traffic demo and smoke test.
        // Revisit sampling before production, higher traffic, or meaningful cost.
        OTEL_TRACES_SAMPLER: 'parentbased_always_on',
        OTEL_RESOURCE_ATTRIBUTES: `deployment.environment.name=${platformConfig.environmentName},service.namespace=${platformConfig.platformName}`,
        ENABLE_GRAPHIQL: 'false',
      },
    });
    appContainer.addPortMappings({
      containerPort: APP_CONTAINER_PORT,
      protocol: ecs.Protocol.TCP,
    });

    // TODO(platform-telemetry): This per-task ADOT sidecar is the issue #37
    // demo topology, not the long-term platform shape. Before adding several
    // microservices or scaling task counts, move export to a dedicated OTel
    // collector service/gateway and point app tasks at that stable OTLP
    // endpoint. Until then, ADOT remains nonessential so collector failure
    // costs telemetry, not application availability.
    taskDefinition.addContainer('AdotContainer', {
      containerName: 'adot-collector',
      image: ecs.ContainerImage.fromDockerImageAsset(adotImage),
      essential: false,
      cpu: 128,
      memoryLimitMiB: 384,
      enableRestartPolicy: true,
      restartAttemptPeriod: cdk.Duration.seconds(60),
      stopTimeout: cdk.Duration.seconds(30),
      logging: ecs.LogDrivers.awsLogs({
        logGroup: adotLogGroup,
        streamPrefix: 'adot',
      }),
      environment: {
        AWS_REGION: cdk.Stack.of(this).region,
        AWS_STS_REGIONAL_ENDPOINTS: 'regional',
        AMP_REMOTE_WRITE_ENDPOINT: cdk.Fn.join('', [ampWorkspace.attrPrometheusEndpoint, 'remote_write']),
        APPLICATION_SERVICE_NAME: platformConfig.serviceName,
        CLOUDWATCH_METRICS_NAMESPACE: cloudWatchApplicationMetricsNamespace,
        CLOUDWATCH_METRICS_LOG_GROUP_NAME: applicationMetricsLogGroup.logGroupName,
        DEPLOYMENT_ENVIRONMENT_NAME: platformConfig.environmentName,
        METRICS_COLLECTION_INTERVAL: `${platformConfig.metricsExportIntervalSeconds}s`,
      },
      healthCheck: {
        command: ['CMD', '/healthcheck'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(10),
      },
    });

    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition,
      serviceName: platformConfig.serviceName,
      desiredCount: 1,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      assignPublicIp: false,
      vpcSubnets: workloadSubnetSelection,
      securityGroups: [serviceSecurityGroup],
      enableExecuteCommand: platformConfig.enableEcsExec,
      circuitBreaker: {
        rollback: true,
      },
      healthCheckGracePeriod: cdk.Duration.seconds(60),
    });
    tagServiceResource(service);

    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
      vpc,
      internetFacing: true,
      crossZoneEnabled: true,
      loadBalancerName: `${platformConfig.environmentName}-backend`,
      securityGroup: albSecurityGroup,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
    });
    tagServiceResource(loadBalancer);

    const listener = loadBalancer.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
    });

    listener.addTargets('EcsTargets', {
      port: APP_CONTAINER_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [
        service.loadBalancerTarget({
          containerName: appContainer.containerName,
          containerPort: APP_CONTAINER_PORT,
        }),
      ],
      healthCheck: {
        path: '/health',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    new cdk.CfnOutput(this, 'LoadBalancerDnsName', {
      value: loadBalancer.loadBalancerDnsName,
      description: 'Public DNS name for the backend ALB',
    });
    new cdk.CfnOutput(this, 'CloudWatchApplicationMetricsNamespace', {
      value: cloudWatchApplicationMetricsNamespace,
      description: 'CloudWatch namespace containing application metrics exported through ADOT EMF',
    });
    new cdk.CfnOutput(this, 'EcsClusterName', {
      value: cluster.clusterName,
      description: 'ECS cluster name used by Container Insights and smoke tooling',
    });
    new cdk.CfnOutput(this, 'EcsServiceName', {
      value: service.serviceName,
      description: 'ECS service name used by Container Insights and smoke tooling',
    });
    new cdk.CfnOutput(this, 'AmpWorkspaceId', {
      value: ampWorkspace.attrWorkspaceId,
      description: 'Amazon Managed Service for Prometheus workspace ID',
    });
    new cdk.CfnOutput(this, 'AmpWorkspaceArn', {
      value: ampWorkspace.attrArn,
      description: 'Amazon Managed Service for Prometheus workspace ARN',
    });
    new cdk.CfnOutput(this, 'AmpPrometheusEndpoint', {
      value: ampWorkspace.attrPrometheusEndpoint,
      description: 'Base Prometheus-compatible API endpoint for the AMP workspace',
    });
    new cdk.CfnOutput(this, 'GrafanaWorkspaceId', {
      value: grafanaWorkspace.attrId,
      description: 'Amazon Managed Grafana workspace ID',
    });
    new cdk.CfnOutput(this, 'GrafanaWorkspaceUrl', {
      value: cdk.Fn.join('', ['https://', grafanaWorkspace.attrEndpoint]),
      description: 'HTTPS URL for the Amazon Managed Grafana workspace',
    });
  }
}
