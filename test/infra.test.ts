import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';

import { MovieReservationWorkloadStack } from '../lib/infra-stack';
import {
  APPLICATION_COMPONENT_INPUTS,
  resolvePlatformConfig,
  type DeploymentTarget,
  type PlatformConfigContext,
} from '../lib/config/platform-config';

const TEST_TARGET = { account: '111111111111', region: 'eu-central-1' } as const satisfies DeploymentTarget;
const TEST_DIGEST = `sha256:${'a'.repeat(64)}`;
const TEST_AUDIT_EVENT_BUS_ARN =
  'arn:aws:events:eu-central-1:222222222222:event-bus/movie-platform-audit';
const TEST_DEMO_AUTH_SECRET_ARN =
  `arn:aws:secretsmanager:${TEST_TARGET.region}:${TEST_TARGET.account}:secret:movie-platform/aws-demo/auth-Ab12Cd`;
const reference = (repository: string) =>
  `${TEST_TARGET.account}.dkr.ecr.${TEST_TARGET.region}.amazonaws.com/${repository}@${TEST_DIGEST}`;
const TEST_CONTEXT = {
  auditEventBusArn: TEST_AUDIT_EVENT_BUS_ARN,
  applicationImageReference: reference('movie-reservation-service'),
  applicationServiceVersion: 'reservation-v1',
  reservationWebImageReference: reference('movie-reservation-web'),
  reservationWebServiceVersion: 'web-v1',
  reservationAgentImageReference: reference('movie-reservation-agent'),
  reservationAgentServiceVersion: 'agent-v1',
  reservationMcpImageReference: reference('movie-reservation-mcp'),
  reservationMcpServiceVersion: 'reservation-mcp-v1',
  recommendationMcpImageReference: reference('movie-recommendation-mcp'),
  recommendationMcpServiceVersion: 'recommendation-mcp-v1',
  recommendationServiceImageReference: reference('movie-recommendation-service'),
  recommendationServiceVersion: 'recommendation-v1',
} as const satisfies PlatformConfigContext;

interface Resource {
  readonly Properties?: Record<string, unknown>;
  readonly DependsOn?: string | string[];
  readonly DeletionPolicy?: string;
  readonly UpdateReplacePolicy?: string;
}

interface EndpointPolicyDocument {
  readonly Statement: Array<{
    readonly Action: string | string[];
    readonly Effect: string;
    readonly Resource: string;
  }>;
}

interface Container {
  readonly Name: string;
  readonly Image: unknown;
  readonly Cpu: number;
  readonly Memory: number;
  readonly Essential: boolean;
  readonly DependsOn?: Array<{ readonly Condition: string; readonly ContainerName: string }>;
  readonly Environment?: Array<{ readonly Name: string; readonly Value: unknown }>;
  readonly HealthCheck?: Record<string, unknown>;
  readonly LogConfiguration?: { readonly Options?: Record<string, unknown> };
  readonly PortMappings?: Array<{ readonly ContainerPort: number }>;
  readonly RestartPolicy?: Record<string, unknown>;
}

function createStack(
  overrides: PlatformConfigContext = {},
  target: DeploymentTarget = TEST_TARGET,
): MovieReservationWorkloadStack {
  const app = new cdk.App();
  return new MovieReservationWorkloadStack(app, 'TestStack', {
    env: target,
    platformConfig: resolvePlatformConfig(
      {
        allowedIngressPrefixListId: 'pl-0123456789abcdef0',
        ...TEST_CONTEXT,
        ...overrides,
      },
      target,
    ),
  });
}

function synthesized(overrides: PlatformConfigContext = {}): Template {
  return Template.fromStack(createStack(overrides));
}

function resources(template: Template, type: string): Resource[] {
  return Object.values(template.findResources(type)) as Resource[];
}

function containers(template: Template): Container[] {
  return resources(template, 'AWS::ECS::TaskDefinition')[0].Properties?.ContainerDefinitions as Container[];
}

function container(template: Template, name: string): Container {
  const found = containers(template).find(({ Name }) => Name === name);
  if (found === undefined) throw new Error(`missing container ${name}`);
  return found;
}

function environment(definition: Container): Record<string, unknown> {
  return Object.fromEntries((definition.Environment ?? []).map(({ Name, Value }) => [Name, Value]));
}

function actions(statement: { readonly Action: string | string[] }): string[] {
  return Array.isArray(statement.Action) ? statement.Action : [statement.Action];
}

// Context validation only: nothing in this block uses the shared synthesized template.
describe('workload platform configuration (CDK context boundary)', () => {
  describe('application images', () => {
    it('validates a complete six-component digest-pinned release', () => {
      const config = resolvePlatformConfig(
        { allowedIngressPrefixListId: 'pl-0123456789abcdef0', ...TEST_CONTEXT },
        TEST_TARGET,
      );

      expect(Object.keys(config.applicationImages).sort()).toEqual(
        APPLICATION_COMPONENT_INPUTS.map(({ componentId }) => componentId).sort(),
      );
      for (const input of APPLICATION_COMPONENT_INPUTS) {
        expect(config.applicationImages[input.componentId]).toMatchObject({
          kind: 'ecr-image',
          componentId: input.componentId,
          repositoryName: input.repositoryName,
          registryAccount: TEST_TARGET.account,
          registryRegion: TEST_TARGET.region,
          imageDigest: TEST_DIGEST,
        });
      }
      expect(config).toMatchObject({
        platformName: 'movie-reservation-platform',
        serviceName: 'movie-platform-demo',
        environmentName: 'aws-demo',
        vpcMaxAzs: 2,
        workloadAzCount: 1,
        enableEcsExec: false,
        auditPublisher: {
          eventBusArn: TEST_AUDIT_EVENT_BUS_ARN,
          timeoutMs: 1_000,
        },
        metricsExportIntervalSeconds: 30,
      });
    });

    it.each(APPLICATION_COMPONENT_INPUTS)(
      'requires both immutable reference and version for $componentId',
      ({ imageReferenceKey, serviceVersionKey }) => {
        expect(() =>
          resolvePlatformConfig(
            {
              allowedIngressPrefixListId: 'pl-0123456789abcdef0',
              ...TEST_CONTEXT,
              [imageReferenceKey]: undefined,
            },
            TEST_TARGET,
          ),
        ).toThrow(String(imageReferenceKey));
        expect(() =>
          resolvePlatformConfig(
            {
              allowedIngressPrefixListId: 'pl-0123456789abcdef0',
              ...TEST_CONTEXT,
              [serviceVersionKey]: ' ',
            },
            TEST_TARGET,
          ),
        ).toThrow(String(serviceVersionKey));
      },
    );

    it('rejects mutable, wrong-repository, cross-account, and cross-Region images', () => {
      expect(() =>
        resolvePlatformConfig(
          {
            allowedIngressPrefixListId: 'pl-0123456789abcdef0',
            ...TEST_CONTEXT,
            reservationWebImageReference:
              `${TEST_TARGET.account}.dkr.ecr.${TEST_TARGET.region}.amazonaws.com/movie-reservation-web:latest`,
          },
          TEST_TARGET,
        ),
      ).toThrow('pinned by a sha256 digest');
      expect(() =>
        resolvePlatformConfig(
          {
            allowedIngressPrefixListId: 'pl-0123456789abcdef0',
            ...TEST_CONTEXT,
            reservationWebImageReference: reference('movie-reservation-agent'),
          },
          TEST_TARGET,
        ),
      ).toThrow('must select ECR repository "movie-reservation-web"');
      expect(() =>
        resolvePlatformConfig(
          { allowedIngressPrefixListId: 'pl-0123456789abcdef0', ...TEST_CONTEXT },
          { account: '222222222222', region: TEST_TARGET.region },
        ),
      ).toThrow('must match deployment account');
      expect(() =>
        resolvePlatformConfig(
          { allowedIngressPrefixListId: 'pl-0123456789abcdef0', ...TEST_CONTEXT },
          { account: TEST_TARGET.account, region: 'us-east-1' },
        ),
      ).toThrow('must match deployment Region');
    });
  });

  describe('ingress, ECS Exec and metrics cadence', () => {
    it('validates ingress, ECS Exec, and metrics cadence at the context boundary', () => {
      expect(() => resolvePlatformConfig({})).toThrow('allowedIngressPrefixListId');
      expect(() =>
        resolvePlatformConfig(
          { allowedIngressPrefixListId: '0.0.0.0/0', ...TEST_CONTEXT },
          TEST_TARGET,
        ),
      ).toThrow('allowedIngressPrefixListId');
      expect(() =>
        resolvePlatformConfig(
          { allowedIngressPrefixListId: 'pl-0123456789abcdef0', ...TEST_CONTEXT, enableEcsExec: 'yes' },
          TEST_TARGET,
        ),
      ).toThrow('enableEcsExec');
      expect(() =>
        resolvePlatformConfig(
          {
            allowedIngressPrefixListId: 'pl-0123456789abcdef0',
            ...TEST_CONTEXT,
            metricsExportIntervalSeconds: 301,
          },
          TEST_TARGET,
        ),
      ).toThrow('metricsExportIntervalSeconds');
      expect(
        resolvePlatformConfig(
          {
            allowedIngressPrefixListId: 'pl-0123456789abcdef0',
            ...TEST_CONTEXT,
            enableEcsExec: 'true',
            metricsExportIntervalSeconds: '45',
          },
          TEST_TARGET,
        ),
      ).toMatchObject({ enableEcsExec: true, metricsExportIntervalSeconds: 45 });
    });
  });

  describe('audit publisher', () => {
    it('validates the cross-account audit bus and bounded publish timeout', () => {
      const context = {
        allowedIngressPrefixListId: 'pl-0123456789abcdef0',
        ...TEST_CONTEXT,
      };
      expect(() => resolvePlatformConfig({ ...context, auditEventBusArn: undefined }, TEST_TARGET))
        .toThrow('auditEventBusArn');
      expect(() => resolvePlatformConfig({ ...context, auditEventBusArn: 'not-an-arn' }, TEST_TARGET))
        .toThrow('custom EventBridge event-bus ARN');
      expect(() => resolvePlatformConfig({
        ...context,
        auditEventBusArn: TEST_AUDIT_EVENT_BUS_ARN.replace('eu-central-1', 'us-east-1'),
      }, TEST_TARGET)).toThrow('deployment Region');
      expect(() => resolvePlatformConfig({
        ...context,
        auditEventBusArn: TEST_AUDIT_EVENT_BUS_ARN.replace('222222222222', TEST_TARGET.account),
      }, TEST_TARGET)).toThrow('separate audit account');
      expect(() => resolvePlatformConfig({
        ...context,
        auditEventBusArn: TEST_AUDIT_EVENT_BUS_ARN.replace('movie-platform-audit', 'default'),
      }, TEST_TARGET)).toThrow('default bus');
      expect(() => resolvePlatformConfig({
        ...context,
        auditEventBusArn: `${TEST_AUDIT_EVENT_BUS_ARN}*`,
      }, TEST_TARGET)).toThrow('without wildcards');
      expect(() => resolvePlatformConfig({ ...context, auditPublishTimeoutMs: 99 }, TEST_TARGET))
        .toThrow('auditPublishTimeoutMs');
      expect(resolvePlatformConfig({
        ...context,
        auditPublishTimeoutMs: '2500',
      }, TEST_TARGET).auditPublisher.timeoutMs).toBe(2_500);
    });
  });

  describe('demo authentication', () => {
    it('rejects incomplete or cross-account demo credential secrets', () => {
      expect(() => synthesized({ demoAuthEnabled: true })).toThrow('demoAuthSecretArn');
      expect(() => synthesized({ demoAuthSecretArn: TEST_DEMO_AUTH_SECRET_ARN })).toThrow('demoAuthEnabled=true');
      expect(() => synthesized({ demoAuthEnabled: true, demoAuthSecretArn: TEST_DEMO_AUTH_SECRET_ARN.replace(TEST_TARGET.account, '222222222222') })).toThrow('deployment account');
    });
  });
});

describe('MovieReservationWorkloadStack', () => {
  // Synthesized once for this block; variant configurations synthesize their own template.
  let template: Template;
  beforeAll(() => {
    template = synthesized();
  });

  describe('container images', () => {
    it('imports all six ECR images by exact digest and builds only owned collector/router assets', () => {
      const stack = createStack();
      expect(stack.node.tryFindChild('AdotImage')).toBeInstanceOf(ecrAssets.DockerImageAsset);
      expect(stack.node.tryFindChild('AuditRouterImage')).toBeInstanceOf(ecrAssets.DockerImageAsset);
      template.resourceCountIs('AWS::ECR::Repository', 0);

      for (const input of APPLICATION_COMPONENT_INPUTS) {
        const definition = container(template, `movie-${input.componentId}`);
        const renderedImage = JSON.stringify(definition.Image);
        expect(renderedImage).toContain(input.repositoryName);
        expect(renderedImage).toContain(TEST_DIGEST);
      }
    });
  });

  describe('private network and endpoints', () => {
    it('creates the no-NAT private workload network and required AWS endpoints', () => {
      template.resourceCountIs('AWS::EC2::NatGateway', 0);
      template.resourceCountIs('AWS::EC2::Subnet', 4);
      template.resourceCountIs('AWS::EC2::InternetGateway', 1);
      const endpointServices = resources(template, 'AWS::EC2::VPCEndpoint').map(
        ({ Properties }) => Properties?.ServiceName,
      );
      for (const suffix of ['ecr.api', 'ecr.dkr', 'logs', 'xray', 'aps-workspaces', 'sts', 'kinesis-firehose', 'events']) {
        expect(JSON.stringify(endpointServices)).toContain(suffix);
      }
    });

    it('restricts the EventBridge endpoint policy to PutEvents on the exact central audit bus', () => {
      const endpoints = resources(template, 'AWS::EC2::VPCEndpoint');
      const eventBridgeEndpoint = endpoints.find(
        ({ Properties }) => JSON.stringify(Properties?.ServiceName).includes('.events'),
      );

      expect(eventBridgeEndpoint).toBeDefined();

      const eventBridgePolicy = eventBridgeEndpoint?.Properties
        ?.PolicyDocument as EndpointPolicyDocument;
      expect(eventBridgePolicy.Statement).toHaveLength(1);

      const statement = eventBridgePolicy.Statement[0];
      expect(statement.Effect).toBe('Allow');
      expect(actions(statement)).toEqual(['events:PutEvents']);
      expect(statement.Resource).toBe(TEST_AUDIT_EVENT_BUS_ARN);
    });

    it('does not request availability-zone lookups for an account without cached context', () => {
      const app = new cdk.App({ context: {} });
      new MovieReservationWorkloadStack(app, 'UncachedWorkload', {
        env: TEST_TARGET,
        platformConfig: resolvePlatformConfig({ allowedIngressPrefixListId: 'pl-0123456789abcdef0', ...TEST_CONTEXT }, TEST_TARGET),
      });
      expect(app.synth().manifest.missing ?? []).toEqual([]);
    });
  });

  describe('task definition', () => {
    it('creates one 2-vCPU/4-GiB task with six essential apps and nonessential ADOT', () => {
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        Cpu: '2048',
        RuntimePlatform: { CpuArchitecture: 'X86_64', OperatingSystemFamily: 'LINUX' },
        Memory: '4096',
        NetworkMode: 'awsvpc',
      });
      const definitions = containers(template);
      expect(definitions).toHaveLength(8);
      expect(definitions.map(({ Name }) => Name).sort()).toEqual(
        [
          'adot-collector',
          'audit-router',
          'movie-recommendation-mcp',
          'movie-recommendation-service',
          'movie-reservation-agent',
          'movie-reservation-mcp',
          'movie-reservation-service',
          'movie-reservation-web',
        ].sort(),
      );
      expect(definitions.filter(({ Essential }) => Essential).length).toBe(7);
      expect(definitions.reduce((total, definition) => total + definition.Cpu, 0)).toBeLessThanOrEqual(2048);
      expect(definitions.reduce((total, definition) => total + definition.Memory, 0)).toBeLessThanOrEqual(4096);
      expect(container(template, 'adot-collector')).toMatchObject({
        Essential: false,
        RestartPolicy: { Enabled: true, RestartAttemptPeriod: 60 },
      });
      for (const name of definitions.filter(({ Name }) => Name.startsWith('movie-')).map(({ Name }) => Name)) {
        expect(container(template, name).HealthCheck).toMatchObject({
          Interval: 15,
          Retries: 5,
          StartPeriod: 20,
          Timeout: 5,
        });
      }
    });

    it('uses the health commands supported by the six published runtime images', () => {
      expect(container(template, 'movie-reservation-service').HealthCheck?.Command).toEqual([
        'CMD',
        '/nodejs/bin/node',
        '-e',
        "fetch('http://127.0.0.1:3000/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))",
      ]);
      expect(container(template, 'movie-recommendation-service').HealthCheck?.Command).toEqual([
        'CMD-SHELL',
        'curl -fsS http://127.0.0.1:8082/ready || exit 1',
      ]);
      expect(container(template, 'movie-reservation-mcp').HealthCheck?.Command).toEqual([
        'CMD',
        'python',
        '-c',
        "from urllib.request import urlopen; urlopen('http://127.0.0.1:8091/health', timeout=2).close()",
      ]);
      expect(container(template, 'movie-recommendation-mcp').HealthCheck?.Command).toEqual([
        'CMD',
        'python',
        '-c',
        "from urllib.request import urlopen; urlopen('http://127.0.0.1:8092/health', timeout=2).close()",
      ]);
      expect(container(template, 'movie-reservation-agent').HealthCheck?.Command).toEqual([
        'CMD',
        'python',
        '-c',
        "from urllib.request import urlopen; urlopen('http://127.0.0.1:8080/health', timeout=2).close()",
      ]);
      expect(container(template, 'movie-reservation-web').HealthCheck?.Command).toEqual([
        'CMD-SHELL',
        'wget -qO- http://127.0.0.1:8088/health >/dev/null || exit 1',
      ]);
      expect(container(template, 'adot-collector').HealthCheck?.Command).toEqual([
        'CMD',
        '/healthcheck',
      ]);
    });

    it('wires task-local URLs, deterministic behavior, faults, versions, and distinct OTLP receivers', () => {
      expect(environment(container(template, 'movie-reservation-service'))).toMatchObject({
        HOST: '0.0.0.0',
        PORT: '3000',
        COMPOSITION_PROFILE: 'local-fixed-user',
        RESERVATION_WORKER_MODE: 'fake-in-process',
        RESERVATION_FAILURE_INJECTION_MODE: 'disabled',
        SERVICE_VERSION: 'reservation-v1',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
      });
      expect(environment(container(template, 'movie-recommendation-service'))).toMatchObject({
        PORT: '8082',
        USE_DUMMY: 'true',
        DEMO_FAULT_MODE: 'none',
        ALLOW_REQUEST_DEMO_FAULTS: 'true',
        SERVICE_VERSION: 'recommendation-v1',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4321',
      });
      expect(environment(container(template, 'movie-reservation-mcp'))).toMatchObject({
        MOVIE_RESERVATION_GRAPHQL_URL: 'http://127.0.0.1:3000/graphql',
        MOVIE_RESERVATION_HEALTH_URL: 'http://127.0.0.1:3000/health',
        MOVIE_RESERVATION_API_TIMEOUT_SECONDS: '10',
        SERVICE_NAMESPACE: 'movie-reservation-platform',
        DEPLOYMENT_ENVIRONMENT: 'aws-demo',
        SERVICE_VERSION: 'reservation-mcp-v1',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4322',
      });
      expect(environment(container(template, 'movie-recommendation-mcp'))).toMatchObject({
        MOVIE_RECOMMENDATION_API_URL: 'http://127.0.0.1:8082',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4320',
      });
      expect(environment(container(template, 'movie-reservation-agent'))).toMatchObject({
        MOVIE_RESERVATION_MCP_URL: 'http://127.0.0.1:8091/mcp',
        MOVIE_RECOMMENDATION_MCP_URL: 'http://127.0.0.1:8092/mcp',
        DEMO_MCP_TIMEOUT_SECONDS: '15',
        DEMO_RESERVATION_POLL_ATTEMPTS: '6',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4319',
      });
      expect(environment(container(template, 'movie-reservation-agent'))).not.toHaveProperty('NO_LLM');

      const telemetryContracts = [
        ['movie-reservation-service', 'reservation-v1', 4318],
        ['movie-reservation-agent', 'agent-v1', 4319],
        ['movie-recommendation-mcp', 'recommendation-mcp-v1', 4320],
        ['movie-recommendation-service', 'recommendation-v1', 4321],
        ['movie-reservation-mcp', 'reservation-mcp-v1', 4322],
      ] as const;
      expect(new Set(telemetryContracts.map(([, , port]) => port)).size).toBe(telemetryContracts.length);
      const mappedContainerPorts = containers(template)
        .flatMap(definition => definition.PortMappings ?? [])
        .map(({ ContainerPort }) => ContainerPort);
      for (const [serviceName, serviceVersion, port] of telemetryContracts) {
        expect(mappedContainerPorts).not.toContain(port);
        expect(environment(container(template, serviceName))).toMatchObject({
          DEPLOYMENT_ENVIRONMENT: 'aws-demo',
          SERVICE_VERSION: serviceVersion,
          OTEL_SERVICE_NAME: serviceName,
          OTEL_TRACES_EXPORTER: 'otlp',
          OTEL_METRICS_EXPORTER: 'otlp',
          OTEL_LOGS_EXPORTER: 'none',
          OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
          OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
          OTEL_PROPAGATORS: 'tracecontext,baggage',
          OTEL_RESOURCE_ATTRIBUTES:
            'deployment.environment.name=aws-demo,service.namespace=movie-reservation-platform',
        });
      }
    });

    it('requires collector readiness before API-to-MCP-to-agent-to-web startup, but tolerates later collector exit', () => {
      const dependency = (name: string, upstream: string, condition = 'HEALTHY') =>
        expect(container(template, name).DependsOn).toContainEqual({
          ContainerName: upstream,
          Condition: condition,
        });

      expect(container(template, 'adot-collector').Essential).toBe(false);
      dependency('movie-reservation-service', 'adot-collector');
      dependency('movie-recommendation-service', 'adot-collector');
      dependency('movie-reservation-mcp', 'movie-reservation-service');
      dependency('movie-reservation-mcp', 'adot-collector');
      dependency('movie-recommendation-mcp', 'movie-recommendation-service');
      dependency('movie-reservation-agent', 'movie-reservation-mcp');
      dependency('movie-reservation-agent', 'movie-recommendation-mcp');
      dependency('movie-reservation-web', 'movie-reservation-agent');
      dependency('movie-reservation-web', 'movie-reservation-service');
    });
  });

  describe('logging', () => {
    it('routes app stdout through an essential bounded FireLens router with ordered shutdown', () => {
      expect(container(template, 'audit-router')).toMatchObject({
        Essential: true, Cpu: 128, Memory: 256, StopTimeout: 120,
        FirelensConfiguration: { Type: 'fluentbit' },
      });
      for (const input of APPLICATION_COMPONENT_INPUTS) {
        const definition = container(template, `movie-${input.componentId}`);
        expect(definition.LogConfiguration).toEqual({
          LogDriver: 'awsfirelens', Options: { 'log-driver-buffer-limit': '1024' },
        });
        expect(definition.DependsOn).toContainEqual({ ContainerName: 'audit-router', Condition: 'START' });
      }
      expect(JSON.stringify(template.toJSON())).not.toContain('"FromPort":24224');
    });

    it('leaves log groups and Grafana to the observability stack', () => {
      template.resourceCountIs('AWS::Logs::LogGroup', 0);
      template.resourceCountIs('AWS::Grafana::Workspace', 0);
      expect(containers(template).filter(({ LogConfiguration }) => LogConfiguration?.Options?.['awslogs-group'])).toHaveLength(2);
    });
  });

  describe('public ingress', () => {
    it('exposes only web port 8088 through the prefix-list-restricted ALB', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        HealthCheckPath: '/health',
        Port: 8088,
        Protocol: 'HTTP',
        TargetType: 'ip',
      });
      const service = resources(template, 'AWS::ECS::Service')[0];
      expect(service.Properties?.HealthCheckGracePeriodSeconds).toBe(180);
      expect(JSON.stringify(service.Properties?.LoadBalancers)).toContain('movie-reservation-web');
      expect(JSON.stringify(service.Properties?.LoadBalancers)).not.toContain('movie-reservation-service');
      template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
        FromPort: 80,
        ToPort: 80,
        IpProtocol: 'tcp',
        SourcePrefixListId: 'pl-0123456789abcdef0',
      });
      template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
        FromPort: 8088,
        ToPort: 8088,
        IpProtocol: 'tcp',
        SourceSecurityGroupId: Match.anyValue(),
      });
      const ingress = resources(template, 'AWS::EC2::SecurityGroupIngress');
      expect(ingress.map(({ Properties }) => Properties?.CidrIp)).not.toContain('0.0.0.0/0');
    });

    it('enables ALB native access logs in the audit-owned bucket', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        LoadBalancerAttributes: Match.arrayWith([
          { Key: 'access_logs.s3.enabled', Value: 'true' },
          { Key: 'access_logs.s3.bucket', Value: { 'Fn::ImportValue': 'MoviePlatformAwsDemo:AlbAccessLogBucketName' } },
          { Key: 'access_logs.s3.prefix', Value: 'alb' },
        ]),
      });
      template.resourceCountIs('AWS::S3::Bucket', 0);
      template.resourceCountIs('AWS::APS::Workspace', 0);
    });
  });

  describe('telemetry', () => {
    it('uses the imported AMP workspace API endpoint for collector remote write', () => {
      expect(environment(container(template, 'adot-collector')).AMP_REMOTE_WRITE_ENDPOINT).toEqual({
        'Fn::Join': ['', [
          { 'Fn::ImportValue': 'MoviePlatformAwsDemo:AmpPrometheusEndpoint' },
          'api/v1/remote_write',
        ]],
      });
    });
  });

  describe('IAM', () => {
    it('shared task role allows telemetry and audit writes but not image publishing or workload deployment', () => {
      const policies = resources(template, 'AWS::IAM::Policy');
      const taskPolicy = policies.find(({ Properties }) =>
        String(Properties?.PolicyName).includes('TaskRoleDefaultPolicy'),
      );
      expect(taskPolicy).toBeDefined();
      const document = taskPolicy?.Properties?.PolicyDocument as {
        readonly Statement: Array<{ readonly Action: string | string[] }>;
      };
      // Every container in the task shares this role, including the applications.
      const allowedActions = document.Statement.flatMap(actions);
      expect(allowedActions).toEqual(expect.arrayContaining([
        'xray:PutTraceSegments', 'aps:RemoteWrite', 'logs:PutLogEvents', 'firehose:PutRecordBatch',
        'events:PutEvents',
      ]));
      expect(document.Statement).toContainEqual(expect.objectContaining({
        Action: 'events:PutEvents',
        Effect: 'Allow',
        Resource: TEST_AUDIT_EVENT_BUS_ARN,
      }));
      expect(allowedActions).not.toContain('ecr:PutImage');
      expect(allowedActions).not.toContain('ecs:UpdateService');
    });
  });

  describe('audit publication', () => {
    it('injects central audit publisher settings only into reservation service', () => {
      expect(environment(container(template, 'movie-reservation-service'))).toMatchObject({
        AUDIT_PUBLISHER: 'eventbridge',
        AUDIT_EVENT_BUS_ARN: TEST_AUDIT_EVENT_BUS_ARN,
        AUDIT_PUBLISH_TIMEOUT_MS: '1000',
        AUDIT_STDOUT_COMPARISON_MIRROR: 'true',
      });
      for (const definition of containers(template)) {
        if (definition.Name === 'movie-reservation-service') continue;
        expect(environment(definition)).not.toHaveProperty('AUDIT_EVENT_BUS_ARN');
        expect(environment(definition)).not.toHaveProperty('AUDIT_PUBLISHER');
      }
    });
  });

  describe('audit-gap alarms', () => {
    const topicLogicalId = () => Object.keys(template.findResources('AWS::SNS::Topic'))[0];

    it('routes alarm transitions to one TLS-only topic without a subscription', () => {
      template.resourceCountIs('AWS::SNS::Topic', 1);
      template.resourceCountIs('AWS::SNS::Subscription', 0);
      template.hasResourceProperties('AWS::SNS::TopicPolicy', {
        PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
          Effect: 'Deny',
          Condition: { Bool: { 'aws:SecureTransport': 'false' } },
        })]) },
      });
      expect(template.toJSON().Outputs.AuditAlarmTopicArn.Value).toEqual({ Ref: topicLogicalId() });
    });

    it('watches every bounded primary publish failure reason and telemetry loss', () => {
      const failureAlarms = resources(template, 'AWS::CloudWatch::Alarm')
        .filter(({ Properties }) => Properties?.MetricName === 'audit_publish_total');
      const reasons = failureAlarms.map(({ Properties }) =>
        (Properties?.Dimensions as { Name: string; Value: string }[])
          .find(({ Name }) => Name === 'failure_reason')?.Value);
      expect(reasons.sort()).toEqual(['aborted', 'configuration', 'rejected', 'throttled', 'timeout', 'unavailable']);

      for (const { Properties } of failureAlarms) {
        expect(Properties).toMatchObject({
          Namespace: 'MoviePlatform/aws-demo/applications',
          Statistic: 'Sum',
          Period: 60,
          EvaluationPeriods: 1,
          Threshold: 0,
          ComparisonOperator: 'GreaterThanThreshold',
          // The service pre-creates zero series, so absence is a broken pipeline, not health.
          TreatMissingData: 'breaching',
        });
        // Children only explain the cause; the composite is the single notifier.
        expect(Properties).not.toHaveProperty('AlarmActions');
        // Role, not transport: the selector survives an EventBridge-to-stdout rollback.
        expect(Properties?.Dimensions).toEqual(expect.arrayContaining([
          { Name: 'ServiceName', Value: 'movie-reservation-service' },
          { Name: 'Environment', Value: 'aws-demo' },
          { Name: 'audit_publisher_role', Value: 'primary' },
          { Name: 'result', Value: 'failed' },
        ]));
        expect(Properties?.Dimensions).toHaveLength(5);
      }
    });

    it('notifies once when any primary publish failure alarm fires', () => {
      const failureAlarmIds = Object.keys(template.findResources('AWS::CloudWatch::Alarm', {
        Properties: { MetricName: 'audit_publish_total' },
      }));
      const [composite] = resources(template, 'AWS::CloudWatch::CompositeAlarm');
      expect(resources(template, 'AWS::CloudWatch::CompositeAlarm')).toHaveLength(1);
      expect(composite.Properties?.AlarmActions).toEqual([{ Ref: topicLogicalId() }]);

      // AlarmRule synthesizes as ALARM("<arn>") OR ALARM("<arn>") ... with ARNs via Fn::GetAtt.
      const rule = JSON.stringify(composite.Properties?.AlarmRule);
      expect(failureAlarmIds).toHaveLength(6);
      for (const alarmId of failureAlarmIds) {
        expect(rule).toContain(`{"Fn::GetAtt":["${alarmId}","Arn"]}`);
      }
      expect(rule.match(/ OR /g)).toHaveLength(5);
    });

    it('alarms when a successful login is not audited', () => {
      const filters = Object.values(template.findResources('AWS::Logs::MetricFilter'));
      expect(filters).toHaveLength(1);
      const [{ Properties: filter }] = filters;
      // Both conditions must hold, and the status is matched as a number.
      expect(filter.FilterPattern).toBe('{ ($.event = "audit.emit.failed") && ($.auth_status_id = 1) }');
      expect(filter.LogGroupName).toEqual({ 'Fn::ImportValue': expect.stringContaining(':ReservationServiceLogGroupName') });
      const [transformation] = filter.MetricTransformations;
      expect(transformation).toMatchObject({ MetricNamespace: 'MoviePlatform/aws-demo/audit-gaps', MetricValue: '1' });

      // Filter and alarm are linked only by namespace + metric name.
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Namespace: transformation.MetricNamespace,
        MetricName: transformation.MetricName,
        Statistic: 'Sum',
        Period: 60,
        EvaluationPeriods: 1,
        Threshold: 0,
        ComparisonOperator: 'GreaterThanThreshold',
        TreatMissingData: 'notBreaching',
        AlarmActions: [{ Ref: topicLogicalId() }],
      });
    });
  });

  describe('ECS Exec', () => {
    it('enables ECS Exec and its endpoint only when explicitly requested', () => {
      expect(JSON.stringify(template.toJSON())).not.toContain('ssmmessages:CreateControlChannel');
      const enabled = synthesized({ enableEcsExec: true });
      enabled.hasResourceProperties('AWS::ECS::Service', { EnableExecuteCommand: true });
      expect(JSON.stringify(enabled.toJSON())).toContain('ssmmessages:CreateControlChannel');
      expect(JSON.stringify(enabled.toJSON())).toContain('ssmmessages');
    });
  });

  describe('demo authentication', () => {
    it('preserves the disabled default for every audit producer', () => {
      for (const producer of ['reservation-service', 'reservation-agent', 'recommendation-service']) {
        expect(environment(container(template, `movie-${producer}`))).toMatchObject({ DEMO_AUTH_ENABLED: 'false' });
      }
    });

    describe('when demo authentication is enabled', () => {
      it('injects demo credentials only through Secrets Manager', () => {
        const enabled = synthesized({ demoAuthEnabled: true, demoAuthSecretArn: TEST_DEMO_AUTH_SECRET_ARN });
        for (const producer of ['reservation-service', 'reservation-agent', 'recommendation-service']) {
          const definition = container(enabled, `movie-${producer}`);
          expect(environment(definition)).toMatchObject({ DEMO_AUTH_ENABLED: 'true', DEPLOYMENT_ENVIRONMENT: 'aws-demo' });
          expect(environment(definition)).not.toHaveProperty('DEMO_AUTH_PASSWORD');
          expect(definition).toMatchObject({ Secrets: [
            { Name: 'DEMO_AUTH_USERNAME', ValueFrom: `${TEST_DEMO_AUTH_SECRET_ARN}:username::` },
            { Name: 'DEMO_AUTH_PASSWORD', ValueFrom: `${TEST_DEMO_AUTH_SECRET_ARN}:password::` },
          ] });
        }
        expect(JSON.stringify(enabled.toJSON())).toContain('secretsmanager:GetSecretValue');
        expect(JSON.stringify(enabled.toJSON())).toContain('secretsmanager');
        const taskPolicy = resources(enabled, 'AWS::IAM::Policy').find(({ Properties }) => String(Properties?.PolicyName).includes('TaskRoleDefaultPolicy'));
        expect(JSON.stringify(taskPolicy)).not.toContain('secretsmanager:GetSecretValue');
      });
    });
  });

  describe('stack outputs', () => {
    it('publishes deployment, telemetry, and per-component log discovery outputs', () => {
      const outputs = template.toJSON().Outputs as Record<string, unknown>;
      for (const output of [
        'DemoBaseUrl',
        'LoadBalancerDnsName',
        'CloudWatchApplicationMetricsNamespace',
        'EcsClusterName',
        'EcsServiceName',
        'AmpWorkspaceId',
        'AmpWorkspaceArn',
        'AmpPrometheusEndpoint',
        'GrafanaWorkspaceId',
        'GrafanaWorkspaceUrl',
        'AdotLogGroupName',
        'AuditAlarmTopicArn',
        'ReservationWebLogGroupName',
        'ReservationAgentLogGroupName',
        'ReservationMcpLogGroupName',
        'RecommendationMcpLogGroupName',
        'ReservationServiceLogGroupName',
        'RecommendationServiceLogGroupName',
      ]) {
        expect(outputs).toHaveProperty(output);
      }
    });
  });
});
