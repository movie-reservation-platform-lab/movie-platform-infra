import * as path from 'node:path';

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { importFoundationOutput } from './stack-bindings';
import { Construct } from 'constructs';

import { resolveApplicationImage } from './application-image';
import type { PlatformConfig } from './config/platform-config';

const WEB_CONTAINER_PORT = 8088;
const AMP_REMOTE_WRITE_ACTIONS = ['aps:RemoteWrite'];
const STS_IDENTITY_ACTIONS = ['sts:GetCallerIdentity'];
const XRAY_WRITE_ACTIONS = ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'];
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

/** ECS, networking and task-local telemetry. Audit/observability are imported foundations. */
export class MovieReservationWorkloadStack extends cdk.Stack {
  // CDK's Vpc validates even explicitly supplied AZs against stack.availabilityZones.
  // Override that lookup too: CloudFormation selects two real account AZs at deploy.
  public override get availabilityZones(): string[] {
    return [
      cdk.Fn.select(0, cdk.Fn.getAzs(this.region)),
      cdk.Fn.select(1, cdk.Fn.getAzs(this.region)),
    ];
  }

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

    const ampWorkspace = {
      attrArn: importFoundationOutput('AmpWorkspaceArn'),
      attrWorkspaceId: importFoundationOutput('AmpWorkspaceId'),
      attrPrometheusEndpoint: importFoundationOutput('AmpPrometheusEndpoint'),
    };
    const grafanaWorkspaceId = importFoundationOutput('GrafanaWorkspaceId');
    const grafanaWorkspaceUrl = importFoundationOutput('GrafanaWorkspaceUrl');
    const auditStreamArn = importFoundationOutput('AuditDeliveryStreamArn');
    const auditStreamName = importFoundationOutput('AuditDeliveryStreamName');

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
    const firehoseEndpoint = vpc.addInterfaceEndpoint('FirehoseEndpoint', {
      ...interfaceEndpointProps,
      service: ec2.InterfaceVpcEndpointAwsService.KINESIS_FIREHOSE,
    });
    firehoseEndpoint.addToPolicy(new iam.PolicyStatement({
      principals: [new iam.AnyPrincipal()],
      actions: ['firehose:PutRecordBatch'],
      resources: [auditStreamArn],
    }));
    if (platformConfig.demoAuthEnabled) {
      const secretsEndpoint = vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
        ...interfaceEndpointProps,
        service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      });
      secretsEndpoint.addToPolicy(new iam.PolicyStatement({
        principals: [new iam.AnyPrincipal()],
        actions: ['secretsmanager:GetSecretValue'],
        resources: [platformConfig.demoAuthSecretArn!],
      }));
    }

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
    const cluster = new ecs.Cluster(this, 'ApplicationCluster', {
      vpc,
      clusterName,
      containerInsightsV2: ecs.ContainerInsights.ENHANCED,
    });

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
      platform: ecrAssets.Platform.LINUX_AMD64,
    });
    const cloudWatchApplicationMetricsNamespace =
      `MoviePlatform/${platformConfig.environmentName}/applications`;

    const componentLogGroups = Object.fromEntries(APPLICATION_COMPONENTS.map(component => {
      const name = component.split('-').map(part => part[0].toUpperCase() + part.slice(1)).join('');
      return [component, logs.LogGroup.fromLogGroupName(this, `${name}Logs`,
        importFoundationOutput(`${name}LogGroupName`))];
    })) as Record<(typeof APPLICATION_COMPONENTS)[number], logs.ILogGroup>;
    const adotLogGroup = logs.LogGroup.fromLogGroupName(this, 'AdotLogs',
      importFoundationOutput('AdotLogGroupName'));
    const applicationMetricsLogGroup = logs.LogGroup.fromLogGroupName(this, 'MetricsLogs',
      importFoundationOutput('ApplicationMetricsLogGroupName'));
    const routerLogGroup = logs.LogGroup.fromLogGroupName(this, 'RouterLogs',
      importFoundationOutput('AuditRouterLogGroupName'));

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      family: `${platformConfig.environmentName}-${platformConfig.serviceName}`,
      cpu: 2048,
      memoryLimitMiB: 4096,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
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
    // FireLens is an application-side API caller: these belong to the task role,
    // not the execution role used to pull images and inject startup secrets.
    taskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
      actions: ['firehose:PutRecordBatch'],
      resources: [auditStreamArn],
    }));
    for (const group of [...Object.values(componentLogGroups), routerLogGroup]) {
      group.grantWrite(taskDefinition.taskRole);
    }
    const demoAuthEnvironment = {
      DEMO_AUTH_ENABLED: String(platformConfig.demoAuthEnabled),
      DEPLOYMENT_ENVIRONMENT: platformConfig.environmentName,
    };
    const demoAuthSecret = platformConfig.demoAuthSecretArn === undefined ? undefined :
      secretsmanager.Secret.fromSecretCompleteArn(this, 'DemoAuthSecret', platformConfig.demoAuthSecretArn);
    const demoAuthSecrets: Record<string, ecs.Secret> = demoAuthSecret === undefined ? {} : {
      DEMO_AUTH_USERNAME: ecs.Secret.fromSecretsManager(demoAuthSecret, 'username'),
      DEMO_AUTH_PASSWORD: ecs.Secret.fromSecretsManager(demoAuthSecret, 'password'),
    };

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

    const routerImage = new ecrAssets.DockerImageAsset(this, 'AuditRouterImage', {
      directory: path.join(repositoryRoot, 'audit-router'),
      platform: ecrAssets.Platform.LINUX_AMD64,
    });
    const auditRouter = taskDefinition.addFirelensLogRouter('AuditRouter', {
      containerName: 'audit-router',
      image: ecs.ContainerImage.fromDockerImageAsset(routerImage),
      firelensConfig: { type: ecs.FirelensLogRouterType.FLUENTBIT },
      essential: true,
      cpu: 128,
      memoryLimitMiB: 256,
      stopTimeout: cdk.Duration.seconds(120),
      logging: ecs.LogDrivers.awsLogs({ logGroup: routerLogGroup, streamPrefix: 'router' }),
      environment: {
        AWS_REGION: this.region,
        AUDIT_DELIVERY_STREAM: auditStreamName,
        ROUTER_LOG_GROUP: routerLogGroup.logGroupName,
      },
    });
    const componentLogging = (_component: (typeof APPLICATION_COMPONENTS)[number]) =>
      ecs.LogDrivers.firelens({ options: { 'log-driver-buffer-limit': '1024' } });
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
      secrets: demoAuthSecrets,
      environment: {
        ...demoAuthEnvironment,
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
      secrets: demoAuthSecrets,
      environment: {
        ...demoAuthEnvironment,
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
      secrets: demoAuthSecrets,
      environment: {
        ...demoAuthEnvironment,
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
      cpu: 128,
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

    // With explicit existing health dependencies, also state the router startup
    // dependency. ECS reverses this order on stop to drain logs before the router.
    for (const application of [reservationService, recommendationService, reservationMcp,
      recommendationMcp, reservationAgent, webContainer]) {
      application.addContainerDependencies({
        container: auditRouter, condition: ecs.ContainerDependencyCondition.START,
      });
    }

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
    loadBalancer.setAttribute('access_logs.s3.enabled', 'true');
    loadBalancer.setAttribute('access_logs.s3.bucket', importFoundationOutput('AlbAccessLogBucketName'));
    loadBalancer.setAttribute('access_logs.s3.prefix', 'alb');

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
      value: grafanaWorkspaceId,
      description: 'Amazon Managed Grafana workspace ID',
    });
    new cdk.CfnOutput(this, 'GrafanaWorkspaceUrl', {
      value: grafanaWorkspaceUrl,
      description: 'HTTPS URL for the Amazon Managed Grafana workspace',
    });
  }
}
