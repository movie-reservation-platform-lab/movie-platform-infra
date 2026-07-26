import * as path from 'node:path';

import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';

import { readDockerfileIgnorePatterns } from '../lib/assets/docker-build-context';
import { readPackageVersion } from '../lib/assets/package-metadata';
import { GoldenPathDemoStack } from '../lib/infra-stack';
import { resolvePlatformConfig, type PlatformConfigContext } from '../lib/config/platform-config';

const REPOSITORY_ROOT = path.join(__dirname, '..', '..');
const APP_DOCKERFILE = 'movie-reservation-service/Dockerfile';

function regionalServiceName(serviceShortName: string) {
  return {
    'Fn::Join': ['', ['com.amazonaws.', { Ref: 'AWS::Region' }, `.${serviceShortName}`]],
  };
}

interface SynthesizedResource {
  readonly Properties?: Record<string, unknown>;
  readonly DeletionPolicy?: string;
  readonly UpdateReplacePolicy?: string;
}

interface SynthesizedContainerDefinition {
  readonly Name: string;
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

function synthesizeTemplate(context: PlatformConfigContext = {}) {
  const app = new cdk.App();
  const stack = new GoldenPathDemoStack(app, 'TestStack', {
    platformConfig: resolvePlatformConfig({
      allowedIngressCidr: '203.0.113.10/32',
      ...context,
    }),
  });

  return Template.fromStack(stack);
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

let template: Template;

beforeAll(() => {
  template = synthesizeTemplate();
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

test('names the application cluster for the platform and environment', () => {
  template.hasResourceProperties('AWS::ECS::Cluster', {
    ClusterName: 'movie-reservation-platform-aws-demo',
    ClusterSettings: [
      {
        Name: 'containerInsights',
        Value: 'disabled',
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

test('creates private endpoints for image pull, log delivery, and X-Ray writes', () => {
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

  const endpoints = findResources(template, 'AWS::EC2::VPCEndpoint');
  const gatewayEndpoints = endpoints.filter((endpoint) => endpoint.Properties?.VpcEndpointType === 'Gateway');
  const interfaceEndpoints = endpoints.filter((endpoint) => endpoint.Properties?.VpcEndpointType === 'Interface');

  expect(gatewayEndpoints).toHaveLength(1);
  expect(gatewayEndpoints[0].Properties?.RouteTableIds).toHaveLength(1);
  expect(interfaceEndpoints).toHaveLength(4);
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
  expect(environmentFor(adotContainer)).toEqual({
    AWS_REGION: { Ref: 'AWS::Region' },
  });
  expect(environmentFor(appContainer)).toMatchObject({
    SERVICE_VERSION: '1.0.0',
    OTEL_SERVICE_NAME: 'movie-reservation-service',
    OTEL_TRACES_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_LOGS_EXPORTER: 'none',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_PROPAGATORS: 'tracecontext,baggage',
    OTEL_TRACES_SAMPLER: 'parentbased_always_on',
    OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment.name=aws-demo,service.namespace=movie-reservation-platform',
  });
});

test('uses separate disposable one-week app and collector log groups', () => {
  const logGroups = findResources(template, 'AWS::Logs::LogGroup');

  expect(logGroups).toHaveLength(2);
  expect(logGroups.map((logGroup) => logGroup.Properties?.LogGroupName)).toEqual([
    '/golden-path/aws-demo/movie-reservation-service/app',
    '/golden-path/aws-demo/movie-reservation-service/adot',
  ]);
  for (const logGroup of logGroups) {
    expect(logGroup.Properties?.RetentionInDays).toBe(7);
    expect(logGroup.DeletionPolicy).toBe('Delete');
    expect(logGroup.UpdateReplacePolicy).toBe('Delete');
  }

  const [appContainer, adotContainer] = findTaskContainers(template);
  expect(appContainer?.LogConfiguration?.Options?.['awslogs-stream-prefix']).toBe('app');
  expect(adotContainer?.LogConfiguration?.Options?.['awslogs-stream-prefix']).toBe('adot');
});

test('grants only X-Ray segment and telemetry writes to the task and endpoint', () => {
  const policies = findResources(template, 'AWS::IAM::Policy');
  const taskRolePolicy = policies.find((policy) =>
    String(policy.Properties?.PolicyName).includes('TaskRoleDefaultPolicy'),
  );

  const policyDocument = taskRolePolicy?.Properties?.PolicyDocument as {
    readonly Statement: Array<{
      readonly Action: string[];
      readonly Effect: string;
      readonly Resource: string;
    }>;
    readonly Version: string;
  };
  expect(policyDocument.Version).toBe('2012-10-17');
  expect(policyDocument.Statement).toHaveLength(1);
  expect(policyDocument.Statement[0]).toMatchObject({
    Effect: 'Allow',
    Resource: '*',
  });
  expect(new Set(policyDocument.Statement[0]?.Action)).toEqual(
    new Set(['xray:PutTraceSegments', 'xray:PutTelemetryRecords']),
  );

  const renderedTemplate = JSON.stringify(template.toJSON());
  expect(renderedTemplate).not.toContain('xray:GetSampling');
  expect(renderedTemplate).not.toContain('AWSXRayDaemonWriteAccess');
});

test('does not introduce deferred metrics, database, or public-network resources', () => {
  template.resourceCountIs('AWS::EC2::NatGateway', 0);
  template.resourceCountIs('AWS::APS::Workspace', 0);
  template.resourceCountIs('AWS::Grafana::Workspace', 0);
  template.resourceCountIs('AWS::RDS::DBInstance', 0);

  const renderedTemplate = JSON.stringify(template.toJSON());
  expect(renderedTemplate).not.toContain('.sts');
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
    vpcMaxAzs: 2,
    workloadAzCount: 1,
    enableEcsExec: false,
  });
});
