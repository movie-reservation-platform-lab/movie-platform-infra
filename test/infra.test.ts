import * as path from 'node:path';

import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';

import { readDockerfileIgnorePatterns } from '../lib/assets/docker-build-context';
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
    Tags: Match.arrayWith([
      Match.objectLike({
        Key: 'Platform',
        Value: 'movie-reservation-platform',
      }),
    ]),
  });

  const cluster = findResources(template, 'AWS::ECS::Cluster')[0];
  const clusterTags = cluster.Properties?.Tags as Array<{ readonly Key: string; readonly Value: string }>;
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

test('creates minimum private endpoints for image pull and log delivery', () => {
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

  const endpoints = findResources(template, 'AWS::EC2::VPCEndpoint');
  const gatewayEndpoints = endpoints.filter((endpoint) => endpoint.Properties?.VpcEndpointType === 'Gateway');
  const interfaceEndpoints = endpoints.filter((endpoint) => endpoint.Properties?.VpcEndpointType === 'Interface');

  expect(gatewayEndpoints).toHaveLength(1);
  expect(gatewayEndpoints[0].Properties?.RouteTableIds).toHaveLength(1);
  expect(interfaceEndpoints).toHaveLength(3);
  for (const endpoint of interfaceEndpoints) {
    expect(endpoint.Properties?.SubnetIds).toHaveLength(1);
  }
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

test('configures the app container for the Wave 2 in-memory backend skeleton', () => {
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    Cpu: '256',
    Memory: '512',
    NetworkMode: 'awsvpc',
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Name: 'movie-reservation-service',
        Essential: true,
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
            Value: 'false',
          }),
        ]),
      }),
    ]),
  });
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
