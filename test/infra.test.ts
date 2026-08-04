import * as path from 'node:path';

import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';

import { readDockerfileIgnorePatterns } from '../lib/assets/docker-build-context';
import { readPackageVersion } from '../lib/assets/package-metadata';
import { GoldenPathDemoStack } from '../lib/infra-stack';
import {
  resolvePlatformConfig,
  type DeploymentTarget,
  type PlatformConfigContext,
} from '../lib/config/platform-config';

const REPOSITORY_ROOT = path.join(__dirname, '..', '..');
const APP_DOCKERFILE = 'movie-reservation-service/Dockerfile';
const ECR_TEST_TARGET = {
  account: '111111111111',
  region: 'eu-central-1',
} as const satisfies DeploymentTarget;
const ECR_TEST_DIGEST = `sha256:${'a'.repeat(64)}`;
const ECR_TEST_IMAGE_REFERENCE =
  `${ECR_TEST_TARGET.account}.dkr.ecr.${ECR_TEST_TARGET.region}.amazonaws.com/ci-placeholder@${ECR_TEST_DIGEST}`;
const ECR_TEST_CONTEXT = {
  applicationImageReference: ECR_TEST_IMAGE_REFERENCE,
  applicationServiceVersion: 'release-2026-07-31',
} as const satisfies PlatformConfigContext;

function regionalServiceName(serviceShortName: string) {
  return {
    'Fn::Join': ['', ['com.amazonaws.', { Ref: 'AWS::Region' }, `.${serviceShortName}`]],
  };
}

interface SynthesizedResource {
  readonly Properties?: Record<string, unknown>;
  readonly DependsOn?: string | string[];
  readonly DeletionPolicy?: string;
  readonly UpdateReplacePolicy?: string;
}

interface SynthesizedContainerDefinition {
  readonly Name: string;
  readonly Image?: unknown;
  readonly Cpu?: number;
  readonly Memory?: number;
  readonly Essential?: boolean;
  readonly DependsOn?: unknown[];
  readonly Environment?: Array<{
    readonly Name: string;
    readonly Value: unknown;
  }>;
  readonly HealthCheck?: Record<string, unknown>;
  readonly LogConfiguration?: {
    readonly Options?: Record<string, unknown>;
  };
  readonly PortMappings?: unknown[];
  readonly RestartPolicy?: Record<string, unknown>;
  readonly StopTimeout?: number;
}

function createStack(context: PlatformConfigContext = {}, deploymentTarget: DeploymentTarget = {}) {
  const app = new cdk.App();
  return new GoldenPathDemoStack(app, 'TestStack', {
    env: deploymentTarget,
    platformConfig: resolvePlatformConfig(
      {
        allowedIngressCidr: '203.0.113.10/32',
        ...context,
      },
      deploymentTarget,
    ),
  });
}

function synthesizeTemplate(context: PlatformConfigContext = {}, deploymentTarget: DeploymentTarget = {}) {
  return Template.fromStack(createStack(context, deploymentTarget));
}

function findResources(templateToSearch: Template, resourceType: string): SynthesizedResource[] {
  return Object.values(templateToSearch.findResources(resourceType)) as SynthesizedResource[];
}

function findTaskContainers(templateToSearch: Template): SynthesizedContainerDefinition[] {
  const taskDefinition = findResources(templateToSearch, 'AWS::ECS::TaskDefinition')[0];
  return taskDefinition.Properties?.ContainerDefinitions as SynthesizedContainerDefinition[];
}

function environmentFor(container: SynthesizedContainerDefinition): Record<string, unknown> {
  return Object.fromEntries((container.Environment ?? []).map(({ Name, Value }) => [Name, Value]));
}

function policyActions(action: string | string[]): string[] {
  return Array.isArray(action) ? action : [action];
}

let template: Template;
let ecrStack: GoldenPathDemoStack;
let ecrTemplate: Template;

beforeAll(() => {
  template = synthesizeTemplate();
  ecrStack = createStack(ECR_TEST_CONTEXT, ECR_TEST_TARGET);
  ecrTemplate = Template.fromStack(ecrStack);
});

test('isolates the app image asset from sibling workspaces', () => {
  const ignoreStrategy = cdk.IgnoreStrategy.docker(
    REPOSITORY_ROOT,
    readDockerfileIgnorePatterns(REPOSITORY_ROOT, APP_DOCKERFILE),
  );

  expect(ignoreStrategy.ignores(path.join(REPOSITORY_ROOT, 'package-lock.json'))).toBe(false);
  expect(ignoreStrategy.ignores(path.join(REPOSITORY_ROOT, 'movie-reservation-service/src/index.ts'))).toBe(false);
  expect(ignoreStrategy.ignores(path.join(REPOSITORY_ROOT, 'ecs-infra/package.json'))).toBe(true);
  expect(ignoreStrategy.ignores(path.join(REPOSITORY_ROOT, 'movie-reservation-web/package.json'))).toBe(true);
  expect(ignoreStrategy.ignores(path.join(REPOSITORY_ROOT, 'docs/plans/ecs-adot-managed-observability.md'))).toBe(true);
});

test('resolves the local application image as the existing AppImage asset', () => {
  expect(createStack().node.tryFindChild('AppImage')).toBeInstanceOf(ecrAssets.DockerImageAsset);
});

test('uses a digest-pinned imported ECR image without creating an app asset or repository', () => {
  expect(ecrStack.node.tryFindChild('AppImage')).toBeUndefined();
  expect(ecrStack.node.tryFindChild('ApplicationImageRepository')).toBeDefined();
  expect(ecrStack.node.tryFindChild('AdotImage')).toBeInstanceOf(ecrAssets.DockerImageAsset);
  ecrTemplate.resourceCountIs('AWS::ECR::Repository', 0);

  const appContainer = findTaskContainers(ecrTemplate).find(({ Name }) => Name === 'movie-reservation-service');
  expect(appContainer).toBeDefined();
  expect(JSON.stringify(appContainer?.Image)).toContain(ECR_TEST_TARGET.account);
  expect(JSON.stringify(appContainer?.Image)).toContain(ECR_TEST_TARGET.region);
  expect(JSON.stringify(appContainer?.Image)).toContain('/ci-placeholder');
  expect(JSON.stringify(appContainer?.Image)).toContain(ECR_TEST_DIGEST);
  if (appContainer === undefined) {
    throw new Error('expected ECR-backed application container');
  }
  expect(environmentFor(appContainer)).toMatchObject({
    SERVICE_VERSION: 'release-2026-07-31',
  });
});

test('grants imported ECR pull access to the execution role but not the application task role', () => {
  const policies = findResources(ecrTemplate, 'AWS::IAM::Policy');
  const executionRolePolicy = policies.find((policy) =>
    String(policy.Properties?.PolicyName).includes('ExecutionRoleDefaultPolicy'),
  );
  const taskRolePolicy = policies.find((policy) =>
    String(policy.Properties?.PolicyName).includes('TaskRoleDefaultPolicy'),
  );
  expect(executionRolePolicy).toBeDefined();
  expect(taskRolePolicy).toBeDefined();
  const executionRolePolicyDocument = executionRolePolicy?.Properties?.PolicyDocument as {
    readonly Statement: Array<{
      readonly Action: string | string[];
      readonly Effect: string;
      readonly Resource: unknown;
    }>;
  };
  const authorizationStatement = executionRolePolicyDocument.Statement.find(({ Action }) =>
    policyActions(Action).includes('ecr:GetAuthorizationToken'),
  );
  const repositoryPullStatement = executionRolePolicyDocument.Statement.find(
    ({ Action, Resource }) =>
      policyActions(Action).includes('ecr:BatchGetImage') &&
      JSON.stringify(Resource).includes('repository/ci-placeholder'),
  );

  expect(authorizationStatement).toMatchObject({
    Effect: 'Allow',
    Resource: '*',
  });
  expect(new Set(policyActions(repositoryPullStatement?.Action ?? []))).toEqual(
    new Set(['ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage']),
  );
  expect(repositoryPullStatement).toMatchObject({
    Effect: 'Allow',
  });
  expect(JSON.stringify(taskRolePolicy?.Properties?.PolicyDocument)).not.toContain('ecr:');
});

test('preserves the ECS runtime and ALB deployment contract in ECR image mode', () => {
  ecrTemplate.hasResourceProperties('AWS::ECS::TaskDefinition', {
    Cpu: '512',
    Memory: '1024',
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Name: 'movie-reservation-service',
        Essential: true,
        Cpu: 384,
        Memory: 640,
        PortMappings: Match.arrayWith([
          Match.objectLike({
            ContainerPort: 3000,
            Protocol: 'tcp',
          }),
        ]),
        Environment: Match.arrayWith([
          Match.objectLike({
            Name: 'SERVICE_VERSION',
            Value: 'release-2026-07-31',
          }),
          Match.objectLike({
            Name: 'OTEL_SERVICE_NAME',
            Value: 'movie-reservation-service',
          }),
        ]),
      }),
      Match.objectLike({
        Name: 'adot-collector',
        Essential: false,
      }),
    ]),
  });
  ecrTemplate.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
    HealthCheckPath: '/health',
    Port: 3000,
    Protocol: 'HTTP',
  });
  ecrTemplate.hasResourceProperties('AWS::ECS::Service', {
    DeploymentConfiguration: Match.objectLike({
      MaximumPercent: 200,
      MinimumHealthyPercent: 100,
    }),
    DesiredCount: 1,
    EnableExecuteCommand: false,
  });
  const service = findResources(ecrTemplate, 'AWS::ECS::Service')[0];
  const networkConfiguration = service.Properties?.NetworkConfiguration as {
    readonly AwsvpcConfiguration: {
      readonly AssignPublicIp: string;
      readonly Subnets: unknown[];
    };
  };
  expect(networkConfiguration.AwsvpcConfiguration.AssignPublicIp).toBe('DISABLED');
  expect(networkConfiguration.AwsvpcConfiguration.Subnets).toHaveLength(1);
  ecrTemplate.resourceCountIs('AWS::EC2::NatGateway', 0);
});

test('reads the service version from structured package metadata', () => {
  expect(readPackageVersion(path.join(REPOSITORY_ROOT, 'movie-reservation-service', 'package.json'))).toBe('1.0.0');
});

test('creates a two-AZ no-NAT VPC while keeping the workload in one subnet', () => {
  template.resourceCountIs('AWS::EC2::NatGateway', 0);
  template.resourceCountIs('AWS::EC2::Subnet', 4);
  template.resourceCountIs('AWS::EC2::InternetGateway', 1);

  const loadBalancer = findResources(template, 'AWS::ElasticLoadBalancingV2::LoadBalancer')[0];
  expect(loadBalancer.Properties?.Subnets).toHaveLength(2);

  const service = findResources(template, 'AWS::ECS::Service')[0];
  const networkConfiguration = service.Properties?.NetworkConfiguration as {
    readonly AwsvpcConfiguration: {
      readonly AssignPublicIp: string;
      readonly Subnets: unknown[];
    };
  };
  expect(networkConfiguration.AwsvpcConfiguration.AssignPublicIp).toBe('DISABLED');
  expect(networkConfiguration.AwsvpcConfiguration.Subnets).toHaveLength(1);
});

test('names the application cluster and enables enhanced Container Insights', () => {
  template.hasResourceProperties('AWS::ECS::Cluster', {
    ClusterName: 'movie-reservation-platform-aws-demo',
    ClusterSettings: [
      {
        Name: 'containerInsights',
        Value: 'enhanced',
      },
    ],
    Tags: Match.arrayWith([
      Match.objectLike({
        Key: 'Platform',
        Value: 'movie-reservation-platform',
      }),
    ]),
  });

  const cluster = findResources(template, 'AWS::ECS::Cluster')[0];
  const clusterTags = cluster.Properties?.Tags as Array<{
    readonly Key: string;
    readonly Value: string;
  }>;
  expect(clusterTags).not.toContainEqual({
    Key: 'Service',
    Value: 'movie-reservation-service',
  });
  expect(cluster.DependsOn).toEqual(expect.arrayContaining([expect.stringContaining('ContainerInsightsLogGroup')]));
});

test('restricts public ALB ingress to the configured CIDR', () => {
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    GroupDescription: 'Allows restricted HTTP ingress to the public demo ALB',
    SecurityGroupIngress: Match.arrayWith([
      Match.objectLike({
        CidrIp: '203.0.113.10/32',
        FromPort: 80,
        IpProtocol: 'tcp',
        ToPort: 80,
      }),
    ]),
  });
});

test('creates one-subnet private endpoints for runtime AWS API calls', () => {
  template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
    VpcEndpointType: 'Gateway',
    ServiceName: regionalServiceName('s3'),
  });
  template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
    VpcEndpointType: 'Interface',
    ServiceName: regionalServiceName('ecr.api'),
  });
  template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
    VpcEndpointType: 'Interface',
    ServiceName: regionalServiceName('ecr.dkr'),
  });
  template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
    VpcEndpointType: 'Interface',
    ServiceName: regionalServiceName('logs'),
  });
  template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
    VpcEndpointType: 'Interface',
    ServiceName: regionalServiceName('xray'),
    PrivateDnsEnabled: true,
    PolicyDocument: Match.anyValue(),
  });
  template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
    VpcEndpointType: 'Interface',
    ServiceName: regionalServiceName('aps-workspaces'),
    PrivateDnsEnabled: true,
    PolicyDocument: Match.anyValue(),
  });
  template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
    VpcEndpointType: 'Interface',
    ServiceName: regionalServiceName('sts'),
    PrivateDnsEnabled: true,
    PolicyDocument: Match.anyValue(),
  });

  const endpoints = findResources(template, 'AWS::EC2::VPCEndpoint');
  const gatewayEndpoints = endpoints.filter((endpoint) => endpoint.Properties?.VpcEndpointType === 'Gateway');
  const interfaceEndpoints = endpoints.filter((endpoint) => endpoint.Properties?.VpcEndpointType === 'Interface');

  expect(gatewayEndpoints).toHaveLength(1);
  expect(gatewayEndpoints[0].Properties?.RouteTableIds).toHaveLength(1);
  expect(interfaceEndpoints).toHaveLength(6);
  for (const endpoint of interfaceEndpoints) {
    expect(endpoint.Properties?.SubnetIds).toHaveLength(1);
  }

  const xrayEndpoint = interfaceEndpoints.find((endpoint) =>
    JSON.stringify(endpoint.Properties?.ServiceName).includes('.xray'),
  );
  const xrayEndpointPolicy = xrayEndpoint?.Properties?.PolicyDocument as {
    readonly Statement: Array<{
      readonly Action: string[];
      readonly Effect: string;
      readonly Principal: { readonly AWS: string };
      readonly Resource: string;
    }>;
  };
  expect(xrayEndpointPolicy.Statement).toHaveLength(1);
  expect(xrayEndpointPolicy.Statement[0]).toMatchObject({
    Effect: 'Allow',
    Principal: { AWS: '*' },
    Resource: '*',
  });
  expect(new Set(xrayEndpointPolicy.Statement[0]?.Action)).toEqual(
    new Set(['xray:PutTraceSegments', 'xray:PutTelemetryRecords']),
  );

  const ampEndpoint = interfaceEndpoints.find((endpoint) =>
    JSON.stringify(endpoint.Properties?.ServiceName).includes('.aps-workspaces'),
  );
  expect(ampEndpoint?.Properties?.PolicyDocument).toEqual({
    Statement: [
      {
        Action: 'aps:RemoteWrite',
        Effect: 'Allow',
        Principal: { AWS: '*' },
        Resource: {
          'Fn::GetAtt': [expect.stringContaining('AmpWorkspace'), 'Arn'],
        },
      },
    ],
    Version: '2012-10-17',
  });

  const stsEndpoint = interfaceEndpoints.find((endpoint) =>
    JSON.stringify(endpoint.Properties?.ServiceName).includes('.sts'),
  );
  expect(stsEndpoint?.Properties?.PolicyDocument).toEqual({
    Statement: [
      {
        Action: 'sts:GetCallerIdentity',
        Effect: 'Allow',
        Principal: { AWS: '*' },
        Resource: '*',
      },
    ],
    Version: '2012-10-17',
  });
});

test('creates a disposable seven-day AMP workspace', () => {
  template.hasResourceProperties('AWS::APS::Workspace', {
    Alias: 'movie-reservation-platform-aws-demo',
    WorkspaceConfiguration: {
      RetentionPeriodInDays: 7,
    },
    Tags: Match.arrayWith([
      Match.objectLike({
        Key: 'Service',
        Value: 'movie-reservation-service',
      }),
    ]),
  });

  const [workspace] = findResources(template, 'AWS::APS::Workspace');
  expect(workspace.DeletionPolicy).toBe('Delete');
  expect(workspace.UpdateReplacePolicy).toBe('Delete');
});

test('grants Grafana only the planned AMP and CloudWatch metric reads', () => {
  template.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: 'sts:AssumeRole',
          Condition: {
            ArnLike: {
              'aws:SourceArn': {
                'Fn::Join': [
                  '',
                  [
                    'arn:',
                    { Ref: 'AWS::Partition' },
                    ':grafana:',
                    { Ref: 'AWS::Region' },
                    ':',
                    { Ref: 'AWS::AccountId' },
                    ':/workspaces/*',
                  ],
                ],
              },
            },
            StringEquals: {
              'aws:SourceAccount': { Ref: 'AWS::AccountId' },
            },
          },
          Effect: 'Allow',
          Principal: {
            Service: 'grafana.amazonaws.com',
          },
        }),
      ]),
    },
  });

  const grafanaPolicy = findResources(template, 'AWS::IAM::Policy').find((policy) => {
    const policyDocument = policy.Properties?.PolicyDocument as {
      readonly Statement?: Array<{ readonly Action?: string | string[] }>;
    };

    return policyDocument.Statement?.some(({ Action }) => policyActions(Action ?? []).includes('aps:QueryMetrics'));
  });
  const policyDocument = grafanaPolicy?.Properties?.PolicyDocument as {
    readonly Statement: Array<{
      readonly Action: string | string[];
      readonly Effect: string;
      readonly Resource: unknown;
    }>;
    readonly Version: string;
  };
  expect(policyDocument.Version).toBe('2012-10-17');
  expect(policyDocument.Statement).toHaveLength(2);

  const ampQueryStatement = policyDocument.Statement.find(({ Action }) =>
    policyActions(Action).includes('aps:QueryMetrics'),
  );
  expect(new Set(policyActions(ampQueryStatement?.Action ?? []))).toEqual(
    new Set(['aps:GetLabels', 'aps:GetMetricMetadata', 'aps:GetSeries', 'aps:QueryMetrics']),
  );
  expect(ampQueryStatement).toMatchObject({
    Effect: 'Allow',
    Resource: {
      'Fn::GetAtt': [expect.stringContaining('AmpWorkspace'), 'Arn'],
    },
  });

  const cloudWatchQueryStatement = policyDocument.Statement.find(({ Action }) =>
    policyActions(Action).includes('cloudwatch:GetMetricData'),
  );
  expect(new Set(policyActions(cloudWatchQueryStatement?.Action ?? []))).toEqual(
    new Set(['cloudwatch:GetMetricData', 'cloudwatch:ListMetrics', 'ec2:DescribeRegions']),
  );
  expect(cloudWatchQueryStatement).toMatchObject({
    Effect: 'Allow',
    Resource: '*',
  });

  const renderedGrafanaPolicy = JSON.stringify(policyDocument);
  expect(renderedGrafanaPolicy).not.toContain('logs:');
  expect(renderedGrafanaPolicy).not.toContain('xray:');
  expect(renderedGrafanaPolicy).not.toContain('cloudwatch:DescribeAlarms');
  expect(renderedGrafanaPolicy).not.toContain('sns:');
  expect(renderedGrafanaPolicy).not.toContain('"Action":"*"');
});

test('restricts the Managed Grafana workspace to the configured CIDR and Identity Center', () => {
  template.hasResourceProperties('AWS::EC2::PrefixList', {
    AddressFamily: 'IPv4',
    Entries: [
      {
        Cidr: '203.0.113.10/32',
        Description: 'Trusted laptop CIDR for the disposable Grafana workspace',
      },
    ],
    MaxEntries: 1,
    PrefixListName: 'movie-reservation-platform-aws-demo-grafana-access',
  });
  template.hasResourceProperties('AWS::Grafana::Workspace', {
    AccountAccessType: 'CURRENT_ACCOUNT',
    AuthenticationProviders: ['AWS_SSO'],
    Name: 'movie-reservation-platform-aws-demo',
    NetworkAccessControl: {
      PrefixListIds: [
        {
          'Fn::GetAtt': [Match.stringLikeRegexp('GrafanaAccessPrefixList'), 'PrefixListId'],
        },
      ],
      VpceIds: [],
    },
    PermissionType: 'CUSTOMER_MANAGED',
    RoleArn: {
      'Fn::GetAtt': [Match.stringLikeRegexp('GrafanaDataAccessRole'), 'Arn'],
    },
  });

  const [workspace] = findResources(template, 'AWS::Grafana::Workspace');
  expect(workspace.DependsOn).toEqual(
    expect.arrayContaining([expect.stringContaining('GrafanaDataAccessPolicy')]),
  );
  expect(workspace.DeletionPolicy).toBe('Delete');
  expect(workspace.UpdateReplacePolicy).toBe('Delete');
  expect(workspace.Properties).not.toHaveProperty('DataSources');
  expect(workspace.Properties).not.toHaveProperty('GrafanaVersion');
  expect(workspace.Properties).not.toHaveProperty('NotificationDestinations');
  expect(workspace.Properties).not.toHaveProperty('PluginAdminEnabled');
  expect(workspace.Properties).not.toHaveProperty('VpcConfiguration');
});

test('keeps AWS endpoint ingress on HTTPS without exposing collector ports', () => {
  const ingressRules = findResources(template, 'AWS::EC2::SecurityGroupIngress');
  const ingressPorts = ingressRules.map((rule) => rule.Properties?.FromPort);

  expect(ingressPorts).toEqual(expect.arrayContaining([3000, 443]));
  expect(ingressPorts).not.toEqual(expect.arrayContaining([4318, 13133]));
  template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
    Description: 'Private ECS tasks use HTTPS to AWS service endpoints',
    FromPort: 443,
    IpProtocol: 'tcp',
    ToPort: 443,
  });
});

test('creates backend ECS service behind an HTTP ALB health checked on /health', () => {
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
    LoadBalancerAttributes: Match.arrayWith([
      Match.objectLike({
        Key: 'load_balancing.cross_zone.enabled',
        Value: 'true',
      }),
    ]),
    Scheme: 'internet-facing',
    Type: 'application',
  });
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
    HealthCheckPath: '/health',
    Port: 3000,
    Protocol: 'HTTP',
    TargetType: 'ip',
  });
  template.hasResourceProperties('AWS::ECS::Service', {
    DeploymentConfiguration: Match.objectLike({
      MaximumPercent: 200,
      MinimumHealthyPercent: 100,
    }),
    DesiredCount: 1,
    LaunchType: 'FARGATE',
    EnableExecuteCommand: false,
  });
});

test('configures an independent app and nonessential ADOT sidecar in one Fargate task', () => {
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    Cpu: '512',
    Memory: '1024',
    NetworkMode: 'awsvpc',
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Name: 'movie-reservation-service',
        Essential: true,
        Cpu: 384,
        Memory: 640,
        PortMappings: Match.arrayWith([
          Match.objectLike({
            ContainerPort: 3000,
            Protocol: 'tcp',
          }),
        ]),
        Environment: Match.arrayWith([
          Match.objectLike({
            Name: 'HOST',
            Value: '0.0.0.0',
          }),
          Match.objectLike({
            Name: 'COMPOSITION_PROFILE',
            Value: 'local-fixed-user',
          }),
          Match.objectLike({
            Name: 'OBSERVABILITY_ENABLED',
            Value: 'true',
          }),
        ]),
      }),
      Match.objectLike({
        Name: 'adot-collector',
        Essential: false,
        Cpu: 128,
        Memory: 384,
        HealthCheck: {
          Command: ['CMD', '/healthcheck'],
          Interval: 30,
          Retries: 3,
          StartPeriod: 10,
          Timeout: 5,
        },
        RestartPolicy: {
          Enabled: true,
          RestartAttemptPeriod: 60,
        },
        StopTimeout: 30,
      }),
    ]),
  });

  const containers = findTaskContainers(template);
  expect(containers).toHaveLength(2);
  const appContainer = containers.find(({ Name }) => Name === 'movie-reservation-service');
  const adotContainer = containers.find(({ Name }) => Name === 'adot-collector');
  expect(appContainer).toBeDefined();
  expect(adotContainer).toBeDefined();
  if (appContainer === undefined || adotContainer === undefined) {
    throw new Error('expected app and ADOT containers');
  }

  expect(appContainer.DependsOn).toBeUndefined();
  expect(adotContainer.PortMappings).toBeUndefined();
  expect(environmentFor(appContainer)).toMatchObject({
    SERVICE_VERSION: '1.0.0',
    OTEL_SERVICE_NAME: 'movie-reservation-service',
    OTEL_TRACES_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_METRIC_EXPORT_INTERVAL: '30000',
    OTEL_LOGS_EXPORTER: 'none',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_PROPAGATORS: 'tracecontext,baggage',
    OTEL_TRACES_SAMPLER: 'parentbased_always_on',
    OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment.name=aws-demo,service.namespace=movie-reservation-platform',
    RESERVATION_WORKER_MODE: 'fake-in-process',
    RESERVATION_FAILURE_INJECTION_MODE: 'stable-random-unexpected-error',
    RESERVATION_FAILURE_INJECTION_RATE: '0.4',
    RESERVATION_FAILURE_INJECTION_SALT: 'aws-demo-managed-observability',
  });
  expect(environmentFor(adotContainer)).toEqual({
    AMP_REMOTE_WRITE_ENDPOINT: {
      'Fn::Join': [
        '',
        [
          {
            'Fn::GetAtt': [expect.stringContaining('AmpWorkspace'), 'PrometheusEndpoint'],
          },
          'remote_write',
        ],
      ],
    },
    AWS_REGION: { Ref: 'AWS::Region' },
    AWS_STS_REGIONAL_ENDPOINTS: 'regional',
    APPLICATION_SERVICE_NAME: 'movie-reservation-service',
    CLOUDWATCH_METRICS_NAMESPACE: 'GoldenPath/aws-demo/movie-reservation-service',
    CLOUDWATCH_METRICS_LOG_GROUP_NAME: {
      Ref: expect.stringContaining('ApplicationMetricsLogGroup'),
    },
    DEPLOYMENT_ENVIRONMENT_NAME: 'aws-demo',
    METRICS_COLLECTION_INTERVAL: '30s',
  });
});

test('uses separate disposable one-week application, collector, EMF, and Container Insights log groups', () => {
  const logGroups = findResources(template, 'AWS::Logs::LogGroup');

  expect(logGroups).toHaveLength(4);
  expect(logGroups.map((logGroup) => logGroup.Properties?.LogGroupName)).toEqual(
    expect.arrayContaining([
      '/aws/ecs/containerinsights/movie-reservation-platform-aws-demo/performance',
      '/golden-path/aws-demo/movie-reservation-service/app',
      '/golden-path/aws-demo/movie-reservation-service/adot',
      '/golden-path/aws-demo/movie-reservation-service/metrics',
    ]),
  );
  for (const logGroup of logGroups) {
    expect(logGroup.Properties?.RetentionInDays).toBe(7);
    expect(logGroup.DeletionPolicy).toBe('Delete');
    expect(logGroup.UpdateReplacePolicy).toBe('Delete');
  }

  const [appContainer, adotContainer] = findTaskContainers(template);
  expect(appContainer?.LogConfiguration?.Options?.['awslogs-stream-prefix']).toBe('app');
  expect(adotContainer?.LogConfiguration?.Options?.['awslogs-stream-prefix']).toBe('adot');
});

test('grants only X-Ray, workspace-scoped AMP, and scoped EMF log writes to the task role', () => {
  const policies = findResources(template, 'AWS::IAM::Policy');
  const taskRolePolicy = policies.find((policy) =>
    String(policy.Properties?.PolicyName).includes('TaskRoleDefaultPolicy'),
  );

  const policyDocument = taskRolePolicy?.Properties?.PolicyDocument as {
    readonly Statement: Array<{
      readonly Action: string | string[];
      readonly Effect: string;
      readonly Resource: unknown;
    }>;
    readonly Version: string;
  };
  expect(policyDocument.Version).toBe('2012-10-17');
  expect(policyDocument.Statement).toHaveLength(3);
  const xrayStatement = policyDocument.Statement.find(({ Action }) =>
    policyActions(Action).includes('xray:PutTraceSegments'),
  );
  const ampStatement = policyDocument.Statement.find(({ Action }) => policyActions(Action).includes('aps:RemoteWrite'));
  const metricsLogStatement = policyDocument.Statement.find(({ Action }) =>
    policyActions(Action).includes('logs:PutLogEvents'),
  );
  expect(xrayStatement).toMatchObject({
    Effect: 'Allow',
    Resource: '*',
  });
  expect(new Set(policyActions(xrayStatement?.Action ?? []))).toEqual(
    new Set(['xray:PutTraceSegments', 'xray:PutTelemetryRecords']),
  );
  expect(ampStatement).toEqual({
    Action: 'aps:RemoteWrite',
    Effect: 'Allow',
    Resource: {
      'Fn::GetAtt': [expect.stringContaining('AmpWorkspace'), 'Arn'],
    },
  });
  expect(metricsLogStatement).toMatchObject({
    Effect: 'Allow',
    Resource: {
      'Fn::GetAtt': [expect.stringContaining('ApplicationMetricsLogGroup'), 'Arn'],
    },
  });
  expect(new Set(policyActions(metricsLogStatement?.Action ?? []))).toEqual(
    new Set(['logs:CreateLogStream', 'logs:PutLogEvents']),
  );

  const renderedTemplate = JSON.stringify(template.toJSON());
  expect(renderedTemplate).not.toContain('xray:GetSampling');
  expect(renderedTemplate).not.toContain('AWSXRayDaemonWriteAccess');
  expect(renderedTemplate).not.toContain('CloudWatchAgentServerPolicy');
});

test('does not introduce deferred databases, alarms, or public-network resources', () => {
  template.resourceCountIs('AWS::EC2::NatGateway', 0);
  template.resourceCountIs('AWS::APS::Workspace', 1);
  template.resourceCountIs('AWS::Grafana::Workspace', 1);
  template.resourceCountIs('AWS::EC2::PrefixList', 1);
  template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
  template.resourceCountIs('AWS::RDS::DBInstance', 0);

  const renderedTemplate = JSON.stringify(template.toJSON());
  expect(renderedTemplate).not.toContain('".aps"]');
  expect(findTaskContainers(template).map(({ Name }) => Name)).not.toEqual(
    expect.arrayContaining(['postgres', 'migration']),
  );
});

test('adds ECS Exec wiring only when enabled', () => {
  const execEnabledTemplate = synthesizeTemplate({
    enableEcsExec: 'true',
  });

  execEnabledTemplate.hasResourceProperties('AWS::ECS::Service', {
    EnableExecuteCommand: true,
  });
  execEnabledTemplate.hasResourceProperties('AWS::EC2::VPCEndpoint', {
    VpcEndpointType: 'Interface',
    ServiceName: regionalServiceName('ssmmessages'),
  });
  execEnabledTemplate.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: Match.arrayWith([
            'ssmmessages:CreateControlChannel',
            'ssmmessages:CreateDataChannel',
            'ssmmessages:OpenControlChannel',
            'ssmmessages:OpenDataChannel',
          ]),
          Effect: 'Allow',
          Resource: '*',
        }),
      ]),
    }),
  });

  expect(JSON.stringify(template.toJSON())).not.toContain('ssmmessages:CreateControlChannel');
});

test('requires allowedIngressCidr at the config boundary', () => {
  expect(() => resolvePlatformConfig({})).toThrow('allowedIngressCidr');
});

test('rejects an internet-wide ALB ingress CIDR', () => {
  expect(() => resolvePlatformConfig({ allowedIngressCidr: '0.0.0.0/0' })).toThrow(
    'allowedIngressCidr" must not be 0.0.0.0/0',
  );
});

test('keeps the VPC and workload AZ counts fixed outside caller-controlled context', () => {
  expect(resolvePlatformConfig({ allowedIngressCidr: '203.0.113.10/32' })).toEqual({
    platformName: 'movie-reservation-platform',
    serviceName: 'movie-reservation-service',
    environmentName: 'aws-demo',
    allowedIngressCidr: '203.0.113.10/32',
    applicationImage: {
      kind: 'local-docker-asset',
    },
    vpcMaxAzs: 2,
    workloadAzCount: 1,
    enableEcsExec: false,
    metricsExportIntervalSeconds: 30,
  });
});

test('resolves and trims a matching digest-pinned ECR image contract', () => {
  expect(
    resolvePlatformConfig(
      {
        allowedIngressCidr: '203.0.113.10/32',
        applicationImageReference: `  ${ECR_TEST_IMAGE_REFERENCE}  `,
        applicationServiceVersion: '  release-candidate+build.17  ',
      },
      ECR_TEST_TARGET,
    ).applicationImage,
  ).toEqual({
    kind: 'ecr-image',
    imageReference: ECR_TEST_IMAGE_REFERENCE,
    registryAccount: ECR_TEST_TARGET.account,
    registryRegion: ECR_TEST_TARGET.region,
    repositoryName: 'ci-placeholder',
    imageDigest: ECR_TEST_DIGEST,
    serviceVersion: 'release-candidate+build.17',
  });
});

test.each([
  {
    context: {
      applicationImageReference: ECR_TEST_IMAGE_REFERENCE,
    },
    missingKey: 'applicationServiceVersion',
  },
  {
    context: {
      applicationServiceVersion: 'release-candidate',
    },
    missingKey: 'applicationImageReference',
  },
])('rejects a partial application image contract missing $missingKey', ({ context, missingKey }) => {
  expect(() =>
    resolvePlatformConfig(
      {
        allowedIngressCidr: '203.0.113.10/32',
        ...context,
      },
      ECR_TEST_TARGET,
    ),
  ).toThrow(missingKey);
});

test.each([
  {
    key: 'applicationImageReference',
    context: {
      applicationImageReference: '   ',
      applicationServiceVersion: 'release-candidate',
    },
  },
  {
    key: 'applicationServiceVersion',
    context: {
      applicationImageReference: ECR_TEST_IMAGE_REFERENCE,
      applicationServiceVersion: '',
    },
  },
])('rejects a blank $key', ({ context, key }) => {
  expect(() =>
    resolvePlatformConfig(
      {
        allowedIngressCidr: '203.0.113.10/32',
        ...context,
      },
      ECR_TEST_TARGET,
    ),
  ).toThrow(`"${key}" must be a non-empty string`);
});

test.each([
  ['mutable latest tag', `${ECR_TEST_TARGET.account}.dkr.ecr.eu-central-1.amazonaws.com/ci-placeholder:latest`],
  ['mutable version tag', `${ECR_TEST_TARGET.account}.dkr.ecr.eu-central-1.amazonaws.com/ci-placeholder:1.2.3`],
  ['bare digest', ECR_TEST_DIGEST],
  ['bare repository', `${ECR_TEST_TARGET.account}.dkr.ecr.eu-central-1.amazonaws.com/ci-placeholder`],
  [
    'malformed account',
    `11111111111.dkr.ecr.eu-central-1.amazonaws.com/ci-placeholder@${ECR_TEST_DIGEST}`,
  ],
  [
    'malformed Region',
    `${ECR_TEST_TARGET.account}.dkr.ecr.eu-central.amazonaws.com/ci-placeholder@${ECR_TEST_DIGEST}`,
  ],
  [
    'malformed repository',
    `${ECR_TEST_TARGET.account}.dkr.ecr.eu-central-1.amazonaws.com/Invalid_Repository@${ECR_TEST_DIGEST}`,
  ],
  [
    'short digest',
    `${ECR_TEST_TARGET.account}.dkr.ecr.eu-central-1.amazonaws.com/ci-placeholder@sha256:${'a'.repeat(63)}`,
  ],
  [
    'long digest',
    `${ECR_TEST_TARGET.account}.dkr.ecr.eu-central-1.amazonaws.com/ci-placeholder@sha256:${'a'.repeat(65)}`,
  ],
])('rejects a %s application image reference', (_caseName, applicationImageReference) => {
  expect(() =>
    resolvePlatformConfig(
      {
        allowedIngressCidr: '203.0.113.10/32',
        applicationImageReference,
        applicationServiceVersion: 'release-candidate',
      },
      ECR_TEST_TARGET,
    ),
  ).toThrow('"applicationImageReference" must be a complete private ECR image URI');
});

test.each([
  ['one-character repository', 'a'],
  ['repository longer than 256 characters', 'a'.repeat(257)],
])('rejects a %s', (_caseName, repositoryName) => {
  expect(() =>
    resolvePlatformConfig(
      {
        allowedIngressCidr: '203.0.113.10/32',
        applicationImageReference:
          `${ECR_TEST_TARGET.account}.dkr.ecr.${ECR_TEST_TARGET.region}.amazonaws.com/` +
          `${repositoryName}@${ECR_TEST_DIGEST}`,
        applicationServiceVersion: 'release-candidate',
      },
      ECR_TEST_TARGET,
    ),
  ).toThrow('must contain an ECR repository name from 2 through 256 characters');
});

test.each([
  ['missing account', { region: ECR_TEST_TARGET.region }, 'CDK_DEFAULT_ACCOUNT'],
  ['invalid account', { account: 'not-an-account', region: ECR_TEST_TARGET.region }, 'CDK_DEFAULT_ACCOUNT'],
  ['missing Region', { account: ECR_TEST_TARGET.account }, 'CDK_DEFAULT_REGION'],
  ['invalid Region', { account: ECR_TEST_TARGET.account, region: 'Europe' }, 'CDK_DEFAULT_REGION'],
] satisfies Array<[string, DeploymentTarget, string]>)(
  'rejects ECR mode with a %s deployment target',
  (_caseName, deploymentTarget, expectedMessage) => {
    expect(() =>
      resolvePlatformConfig(
        {
          allowedIngressCidr: '203.0.113.10/32',
          ...ECR_TEST_CONTEXT,
        },
        deploymentTarget,
      ),
    ).toThrow(expectedMessage);
  },
);

test('rejects an ECR registry account that differs from the deployment target', () => {
  expect(() =>
    resolvePlatformConfig(
      {
        allowedIngressCidr: '203.0.113.10/32',
        ...ECR_TEST_CONTEXT,
      },
      {
        account: '222222222222',
        region: ECR_TEST_TARGET.region,
      },
    ),
  ).toThrow('must match deployment account');
});

test('rejects an ECR registry Region that differs from the deployment target', () => {
  expect(() =>
    resolvePlatformConfig(
      {
        allowedIngressCidr: '203.0.113.10/32',
        ...ECR_TEST_CONTEXT,
      },
      {
        account: ECR_TEST_TARGET.account,
        region: 'us-east-1',
      },
    ),
  ).toThrow('must match deployment Region');
});

test('validates and applies the application metric export cadence', () => {
  expect(
    resolvePlatformConfig({
      allowedIngressCidr: '203.0.113.10/32',
      metricsExportIntervalSeconds: '45',
    }).metricsExportIntervalSeconds,
  ).toBe(45);

  const overrideTemplate = synthesizeTemplate({
    metricsExportIntervalSeconds: '45',
  });
  const [appContainer, adotContainer] = findTaskContainers(overrideTemplate);
  expect(environmentFor(appContainer)).toMatchObject({
    OTEL_METRIC_EXPORT_INTERVAL: '45000',
  });
  expect(environmentFor(adotContainer)).toMatchObject({
    METRICS_COLLECTION_INTERVAL: '45s',
  });
});

test.each([4, 301])('rejects metric export cadence outside the supported range: %s', (value) => {
  expect(() =>
    resolvePlatformConfig({
      allowedIngressCidr: '203.0.113.10/32',
      metricsExportIntervalSeconds: value,
    }),
  ).toThrow('metricsExportIntervalSeconds');
});

test.each(['30.5', '', true])('rejects noninteger metric export cadence: %p', (value) => {
  expect(() =>
    resolvePlatformConfig({
      allowedIngressCidr: '203.0.113.10/32',
      metricsExportIntervalSeconds: value,
    }),
  ).toThrow('must be an integer');
});

test('outputs CloudWatch, ECS, AMP, and Grafana identifiers', () => {
  template.hasOutput('CloudWatchApplicationMetricsNamespace', {
    Value: 'GoldenPath/aws-demo/movie-reservation-service',
  });
  template.hasOutput('EcsClusterName', {
    Value: Match.anyValue(),
  });
  template.hasOutput('EcsServiceName', {
    Value: Match.anyValue(),
  });
  template.hasOutput('AmpWorkspaceId', {
    Value: Match.anyValue(),
  });
  template.hasOutput('AmpWorkspaceArn', {
    Value: Match.anyValue(),
  });
  template.hasOutput('AmpPrometheusEndpoint', {
    Value: Match.anyValue(),
  });
  template.hasOutput('GrafanaWorkspaceId', {
    Value: Match.anyValue(),
  });
  template.hasOutput('GrafanaWorkspaceUrl', {
    Value: Match.objectLike({
      'Fn::Join': Match.anyValue(),
    }),
  });
});
