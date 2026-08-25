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

const WEB_CONTAINER_PORT = 8088;
const AMP_REMOTE_WRITE_ACTIONS = ['aps:RemoteWrite'];
const AMP_QUERY_ACTIONS = ['aps:GetLabels', 'aps:GetMetricMetadata', 'aps:GetSeries', 'aps:QueryMetrics'];
const CLOUDWATCH_METRIC_READ_ACTIONS = ['cloudwatch:GetMetricData', 'cloudwatch:ListMetrics'];
const CLOUDWATCH_LOG_GLOBAL_READ_ACTIONS = [
  'logs:DescribeLogGroups',
  'logs:GetQueryResults',
  'logs:StopQuery',
];
const CLOUDWATCH_LOG_SCOPED_READ_ACTIONS = [
  'logs:GetLogEvents',
  'logs:GetLogGroupFields',
  'logs:StartQuery',
];
const STS_IDENTITY_ACTIONS = ['sts:GetCallerIdentity'];
const XRAY_WRITE_ACTIONS = ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'];
const XRAY_READ_ACTIONS = [
  'xray:BatchGetTraces',
  'xray:GetInsight',
  'xray:GetInsightEvents',
  'xray:GetInsightImpactGraph',
  'xray:GetInsightSummaries',
  'xray:GetServiceGraph',
  'xray:GetTimeSeriesServiceStatistics',
  'xray:GetTraceGraph',
  'xray:GetTraceSummaries',
];
const APPLICATION_COMPONENTS = [
  'reservation-web',
  'reservation-agent',
  'reservation-mcp',
  'recommendation-mcp',
  'reservation-service',
  'recommendation-service',
] as const;

/** Input required to synthesize the current demo infrastructure stack. */
export interface MovieReservationWorkloadStackProps extends cdk.StackProps {
  /** Validated platform settings resolved once at the CDK application boundary. */
  readonly platformConfig: PlatformConfig;
}

/**
 * Deploys the movie reservation platform workload.
 *
 * **Note**: This phase intentionally keeps the infrastructure in one CloudFormation
 * stack so the complete request path and its costs are easy to learn, deploy,
 * and tear down together.
 *
 * The stack provisions:
 * - a two-AZ VPC without a NAT gateway
 * - public subnets for a prefix-list-restricted Application Load Balancer
 * - one selected isolated workload subnet for the Fargate service
 * - the S3, ECR, CloudWatch Logs, X-Ray, AMP, and STS endpoints required by private tasks
 * - an optional SSM Messages endpoint and task permissions for ECS Exec
 * - a disposable AMP workspace and enhanced ECS Container Insights
 * - a prefix-list-restricted Managed Grafana workspace and customer-managed metric-read role
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
export class MovieReservationWorkloadStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MovieReservationWorkloadStackProps) {
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
      ec2.Peer.prefixList(platformConfig.allowedIngressPrefixListId),
      ec2.Port.tcp(80),
      'Demo HTTP access restricted by customer-managed prefix list',
    );

    const serviceSecurityGroup = new ec2.SecurityGroup(this, 'ServiceSecurityGroup', {
      vpc,
      description: 'Allows ALB traffic to the private ECS tasks',
    });
    tagServiceResource(serviceSecurityGroup);
    serviceSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(WEB_CONTAINER_PORT),
      'Only the ALB can call the frontend container',
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

    const componentLogGroupNames = Object.fromEntries(
      APPLICATION_COMPONENTS.map((componentId) => [
        componentId,
        `/movie-platform/${platformConfig.environmentName}/${componentId}/app`,
      ]),
    ) as Record<(typeof APPLICATION_COMPONENTS)[number], string>;
    const adotLogGroupName = `/movie-platform/${platformConfig.environmentName}/adot`;
    const applicationMetricsLogGroupName = `/movie-platform/${platformConfig.environmentName}/metrics`;
    const grafanaReadableLogGroupArns = [
      ...Object.values(componentLogGroupNames),
      adotLogGroupName,
      applicationMetricsLogGroupName,
    ].map((logGroupName) =>
      cdk.Stack.of(this).formatArn({
        service: 'logs',
        resource: 'log-group',
        resourceName: `${logGroupName}:*`,
        arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
      }),
    );

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
      description: 'Allows Managed Grafana to read demo metrics, logs, and traces',
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
        new iam.PolicyStatement({
          actions: CLOUDWATCH_LOG_GLOBAL_READ_ACTIONS,
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          actions: CLOUDWATCH_LOG_SCOPED_READ_ACTIONS,
          resources: grafanaReadableLogGroupArns,
        }),
        new iam.PolicyStatement({
          // X-Ray read APIs do not support resource-level permissions.
          actions: XRAY_READ_ACTIONS,
          resources: ['*'],
        }),
      ],
    });

    const grafanaWorkspace = new grafana.CfnWorkspace(this, 'GrafanaWorkspace', {
      accountAccessType: 'CURRENT_ACCOUNT',
      authenticationProviders: ['AWS_SSO'],
      dataSources: ['CLOUDWATCH', 'PROMETHEUS', 'XRAY'],
      description: 'Managed metrics, logs, and traces for the movie reservation AWS demo',
      name: `${platformConfig.platformName}-${platformConfig.environmentName}`,
      networkAccessControl: {
        prefixListIds: [platformConfig.allowedIngressPrefixListId],
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

    const repositoryRoot = process.cwd();
    const images = {
      reservationService: resolveApplicationImage(
        this,
        platformConfig.applicationImages['reservation-service'],
      ),
      reservationWeb: resolveApplicationImage(
        this,
        platformConfig.applicationImages['reservation-web'],
      ),
      reservationAgent: resolveApplicationImage(
        this,
        platformConfig.applicationImages['reservation-agent'],
      ),
      reservationMcp: resolveApplicationImage(
        this,
        platformConfig.applicationImages['reservation-mcp'],
      ),
      recommendationMcp: resolveApplicationImage(
        this,
        platformConfig.applicationImages['recommendation-mcp'],
      ),
      recommendationService: resolveApplicationImage(
        this,
        platformConfig.applicationImages['recommendation-service'],
      ),
    };
    const adotImage = new ecrAssets.DockerImageAsset(this, 'AdotImage', {
      directory: path.join(repositoryRoot, 'adot-collector'),
    });
    const cloudWatchApplicationMetricsNamespace =
      `MoviePlatform/${platformConfig.environmentName}/applications`;

    const componentLogGroups = Object.fromEntries(
      APPLICATION_COMPONENTS.map((componentId) => {
        const constructId = `${componentId
          .split('-')
          .map((part) => part[0].toUpperCase() + part.slice(1))
          .join('')}LogGroup`;
        const logGroup = new logs.LogGroup(this, constructId, {
          logGroupName: componentLogGroupNames[componentId],
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        tagServiceResource(logGroup);
        return [componentId, logGroup];
      }),
    ) as Record<(typeof APPLICATION_COMPONENTS)[number], logs.LogGroup>;
    const adotLogGroup = new logs.LogGroup(this, 'AdotLogGroup', {
      logGroupName: adotLogGroupName,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    tagServiceResource(adotLogGroup);
    const applicationMetricsLogGroup = new logs.LogGroup(this, 'ApplicationMetricsLogGroup', {
      logGroupName: applicationMetricsLogGroupName,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    tagServiceResource(applicationMetricsLogGroup);

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      family: `${platformConfig.environmentName}-${platformConfig.serviceName}`,
      cpu: 2048,
      memoryLimitMiB: 4096,
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

    // This per-task collector is deliberately nonessential: telemetry loss
    // must not make the demo application unavailable.
    const adotContainer = taskDefinition.addContainer('AdotContainer', {
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

    const componentLogging = (componentId: (typeof APPLICATION_COMPONENTS)[number]) =>
      ecs.LogDrivers.awsLogs({
        logGroup: componentLogGroups[componentId],
        streamPrefix: componentId,
      });
    const healthCheck = (command: string[]): ecs.HealthCheck => ({
      command,
      interval: cdk.Duration.seconds(15),
      timeout: cdk.Duration.seconds(5),
      retries: 5,
      startPeriod: cdk.Duration.seconds(20),
    });
    const otelEnvironment = (serviceName: string, port: number): Record<string, string> => ({
      OTEL_SERVICE_NAME: serviceName,
      OTEL_TRACES_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_METRIC_EXPORT_INTERVAL: (platformConfig.metricsExportIntervalSeconds * 1000).toString(),
      OTEL_LOGS_EXPORTER: 'none',
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
      OTEL_PROPAGATORS: 'tracecontext,baggage',
      OTEL_TRACES_SAMPLER: 'parentbased_always_on',
      OTEL_RESOURCE_ATTRIBUTES:
        `deployment.environment.name=${platformConfig.environmentName},service.namespace=${platformConfig.platformName}`,
    });

    const reservationService = taskDefinition.addContainer('ReservationServiceContainer', {
      containerName: 'movie-reservation-service',
      image: images.reservationService.image,
      essential: true,
      cpu: 384,
      memoryLimitMiB: 640,
      logging: componentLogging('reservation-service'),
      environment: {
        PORT: '3000',
        HOST: '0.0.0.0',
        NODE_ENV: 'development',
        LOG_LEVEL: 'info',
        SERVICE_VERSION: images.reservationService.serviceVersion,
        COMPOSITION_PROFILE: 'local-fixed-user',
        RESERVATION_WORKER_MODE: 'fake-in-process',
        RESERVATION_FAILURE_INJECTION_MODE: 'disabled',
        RESERVATION_FAILURE_INJECTION_RATE: '0',
        OBSERVABILITY_ENABLED: 'true',
        ENABLE_GRAPHIQL: 'false',
        ...otelEnvironment('movie-reservation-service', 4318),
      },
      healthCheck: healthCheck([
        'CMD',
        '/nodejs/bin/node',
        '-e',
        "fetch('http://127.0.0.1:3000/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))",
      ]),
    });
    reservationService.addPortMappings({ containerPort: 3000, protocol: ecs.Protocol.TCP });
    reservationService.addContainerDependencies({
      container: adotContainer,
      condition: ecs.ContainerDependencyCondition.HEALTHY,
    });

    const recommendationService = taskDefinition.addContainer('RecommendationServiceContainer', {
      containerName: 'movie-recommendation-service',
      image: images.recommendationService.image,
      essential: true,
      cpu: 384,
      memoryLimitMiB: 512,
      logging: componentLogging('recommendation-service'),
      environment: {
        PORT: '8082',
        USE_DUMMY: 'true',
        DEMO_FAULT_MODE: 'none',
        ALLOW_REQUEST_DEMO_FAULTS: 'true',
        RUST_LOG: 'info',
        SERVICE_VERSION: images.recommendationService.serviceVersion,
        ...otelEnvironment('movie-recommendation-service', 4321),
      },
      healthCheck: healthCheck([
        'CMD-SHELL',
        'curl -fsS http://127.0.0.1:8082/ready || exit 1',
      ]),
    });
    recommendationService.addPortMappings({ containerPort: 8082, protocol: ecs.Protocol.TCP });
    recommendationService.addContainerDependencies({
      container: adotContainer,
      condition: ecs.ContainerDependencyCondition.HEALTHY,
    });

    const reservationMcp = taskDefinition.addContainer('ReservationMcpContainer', {
      containerName: 'movie-reservation-mcp',
      image: images.reservationMcp.image,
      essential: true,
      cpu: 256,
      memoryLimitMiB: 384,
      logging: componentLogging('reservation-mcp'),
      environment: {
        HOST: '0.0.0.0',
        PORT: '8091',
        MOVIE_RESERVATION_GRAPHQL_URL: 'http://127.0.0.1:3000/graphql',
        MOVIE_RESERVATION_HEALTH_URL: 'http://127.0.0.1:3000/health',
        MOVIE_RESERVATION_API_TIMEOUT_SECONDS: '10',
        SERVICE_VERSION: images.reservationMcp.serviceVersion,
      },
      healthCheck: healthCheck([
        'CMD-SHELL',
        'curl -fsS http://127.0.0.1:8091/health || exit 1',
      ]),
    });
    reservationMcp.addPortMappings({ containerPort: 8091, protocol: ecs.Protocol.TCP });
    reservationMcp.addContainerDependencies({
      container: reservationService,
      condition: ecs.ContainerDependencyCondition.HEALTHY,
    });

    const recommendationMcp = taskDefinition.addContainer('RecommendationMcpContainer', {
      containerName: 'movie-recommendation-mcp',
      image: images.recommendationMcp.image,
      essential: true,
      cpu: 256,
      memoryLimitMiB: 384,
      logging: componentLogging('recommendation-mcp'),
      environment: {
        HOST: '0.0.0.0',
        PORT: '8092',
        MOVIE_RECOMMENDATION_API_URL: 'http://127.0.0.1:8082',
        SERVICE_VERSION: images.recommendationMcp.serviceVersion,
        DEPLOYMENT_ENVIRONMENT: platformConfig.environmentName,
        LOG_LEVEL: 'INFO',
        ...otelEnvironment('movie-recommendation-mcp', 4320),
      },
      healthCheck: healthCheck([
        'CMD-SHELL',
        'curl -fsS http://127.0.0.1:8092/health || exit 1',
      ]),
    });
    recommendationMcp.addPortMappings({ containerPort: 8092, protocol: ecs.Protocol.TCP });
    recommendationMcp.addContainerDependencies(
      {
        container: recommendationService,
        condition: ecs.ContainerDependencyCondition.HEALTHY,
      },
      {
        container: adotContainer,
        condition: ecs.ContainerDependencyCondition.HEALTHY,
      },
    );

    const reservationAgent = taskDefinition.addContainer('ReservationAgentContainer', {
      containerName: 'movie-reservation-agent',
      image: images.reservationAgent.image,
      essential: true,
      cpu: 384,
      memoryLimitMiB: 768,
      logging: componentLogging('reservation-agent'),
      environment: {
        MOVIE_RESERVATION_MCP_URL: 'http://127.0.0.1:8091/mcp',
        MOVIE_RECOMMENDATION_MCP_URL: 'http://127.0.0.1:8092/mcp',
        DEMO_MCP_TIMEOUT_SECONDS: '15',
        DEMO_RESERVATION_POLL_ATTEMPTS: '6',
        DEMO_RESERVATION_POLL_INTERVAL_SECONDS: '0.25',
        SERVICE_VERSION: images.reservationAgent.serviceVersion,
        ...otelEnvironment('movie-reservation-agent', 4319),
      },
      healthCheck: healthCheck([
        'CMD-SHELL',
        'curl -fsS http://127.0.0.1:8080/health || exit 1',
      ]),
    });
    reservationAgent.addPortMappings({ containerPort: 8080, protocol: ecs.Protocol.TCP });
    reservationAgent.addContainerDependencies(
      {
        container: reservationMcp,
        condition: ecs.ContainerDependencyCondition.HEALTHY,
      },
      {
        container: recommendationMcp,
        condition: ecs.ContainerDependencyCondition.HEALTHY,
      },
      {
        container: adotContainer,
        condition: ecs.ContainerDependencyCondition.HEALTHY,
      },
    );

    const webContainer = taskDefinition.addContainer('WebContainer', {
      containerName: 'movie-reservation-web',
      image: images.reservationWeb.image,
      essential: true,
      cpu: 256,
      memoryLimitMiB: 256,
      logging: componentLogging('reservation-web'),
      environment: {
        SERVICE_VERSION: images.reservationWeb.serviceVersion,
      },
      healthCheck: healthCheck([
        'CMD-SHELL',
        'wget -qO- http://127.0.0.1:8088/health >/dev/null || exit 1',
      ]),
    });
    webContainer.addPortMappings({ containerPort: WEB_CONTAINER_PORT, protocol: ecs.Protocol.TCP });
    webContainer.addContainerDependencies(
      {
        container: reservationAgent,
        condition: ecs.ContainerDependencyCondition.HEALTHY,
      },
      {
        container: reservationService,
        condition: ecs.ContainerDependencyCondition.HEALTHY,
      },
    );

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
      // The task has an intentional API -> MCP -> agent -> web health-gated
      // startup chain. Give the ALB enough time for that serial readiness path
      // before ECS evaluates target-health failures.
      healthCheckGracePeriod: cdk.Duration.seconds(180),
    });
    tagServiceResource(service);

    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
      vpc,
      internetFacing: true,
      crossZoneEnabled: true,
      loadBalancerName: `${platformConfig.environmentName}-web`,
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
      port: WEB_CONTAINER_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [
        service.loadBalancerTarget({
          containerName: webContainer.containerName,
          containerPort: WEB_CONTAINER_PORT,
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
      description: 'Public DNS name for the temporary integrated demo web ALB',
    });
    new cdk.CfnOutput(this, 'DemoBaseUrl', {
      value: cdk.Fn.join('', ['http://', loadBalancer.loadBalancerDnsName]),
      description: 'Temporary integrated demo base URL',
    });
    for (const componentId of APPLICATION_COMPONENTS) {
      const outputId = `${componentId
        .split('-')
        .map((part) => part[0].toUpperCase() + part.slice(1))
        .join('')}LogGroupName`;
      new cdk.CfnOutput(this, outputId, {
        value: componentLogGroups[componentId].logGroupName,
        description: `CloudWatch log group for ${componentId}`,
      });
    }
    new cdk.CfnOutput(this, 'AdotLogGroupName', {
      value: adotLogGroup.logGroupName,
      description: 'CloudWatch log group for the task-local ADOT collector',
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
