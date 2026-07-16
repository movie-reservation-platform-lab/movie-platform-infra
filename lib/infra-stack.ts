import * as path from 'node:path';

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

import { readDockerfileIgnorePatterns } from './assets/docker-build-context';
import type { PlatformConfig } from './config/platform-config';

const APP_CONTAINER_PORT = 3000;
const APP_DOCKERFILE = 'movie-reservation-service/Dockerfile';

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
 * - the S3, ECR, and CloudWatch Logs endpoints required by private tasks
 * - an optional SSM Messages endpoint and task permissions for ECS Exec
 * - the service image asset, log group, task definition, ECS service, and ALB
 * - common resource tags and the ALB DNS name as a stack output
 *
 * The backend currently uses the in-memory demo composition and has application
 * observability disabled. Later waves can split networking, workloads, and
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

    if (platformConfig.enableEcsExec) {
      vpc.addInterfaceEndpoint('SsmMessagesEndpoint', {
        ...interfaceEndpointProps,
        service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
      });
    }

    const cluster = new ecs.Cluster(this, 'ApplicationCluster', {
      vpc,
      clusterName: `${platformConfig.platformName}-${platformConfig.environmentName}`,
      containerInsightsV2: ecs.ContainerInsights.DISABLED,
    });

    const repositoryRoot = path.join(__dirname, '..', '..');
    const appImage = new ecrAssets.DockerImageAsset(this, 'AppImage', {
      directory: repositoryRoot,
      file: APP_DOCKERFILE,
      exclude: readDockerfileIgnorePatterns(repositoryRoot, APP_DOCKERFILE),
      ignoreMode: cdk.IgnoreMode.DOCKER,
    });

    const appLogGroup = new logs.LogGroup(this, 'AppLogGroup', {
      logGroupName: `/golden-path/${platformConfig.environmentName}/${platformConfig.serviceName}/app`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    tagServiceResource(appLogGroup);

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      family: `${platformConfig.environmentName}-${platformConfig.serviceName}`,
      cpu: 256,
      memoryLimitMiB: 512,
    });
    tagServiceResource(taskDefinition);

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
      image: ecs.ContainerImage.fromDockerImageAsset(appImage),
      essential: true,
      logging: ecs.LogDrivers.awsLogs({
        logGroup: appLogGroup,
        streamPrefix: 'app',
      }),
      environment: {
        PORT: APP_CONTAINER_PORT.toString(),
        HOST: '0.0.0.0',
        NODE_ENV: 'development',
        LOG_LEVEL: 'info',
        SERVICE_VERSION: '0.1.0',
        COMPOSITION_PROFILE: 'local-fixed-user',
        RESERVATION_WORKER_MODE: 'disabled',
        RESERVATION_FAILURE_INJECTION_MODE: 'disabled',
        RESERVATION_FAILURE_INJECTION_RATE: '0',
        OBSERVABILITY_ENABLED: 'false',
        ENABLE_GRAPHIQL: 'false',
      },
    });
    appContainer.addPortMappings({
      containerPort: APP_CONTAINER_PORT,
      protocol: ecs.Protocol.TCP,
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
  }
}
