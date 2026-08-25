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
const reference = (repository: string) =>
  `${TEST_TARGET.account}.dkr.ecr.${TEST_TARGET.region}.amazonaws.com/${repository}@${TEST_DIGEST}`;
const TEST_CONTEXT = {
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

let template: Template;
beforeAll(() => {
  template = synthesized();
});

test('validates a complete six-component digest-pinned release', () => {
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
    metricsExportIntervalSeconds: 30,
  });
});

test.each(APPLICATION_COMPONENT_INPUTS)(
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

test('rejects mutable, wrong-repository, cross-account, and cross-Region images', () => {
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

test('validates ingress, ECS Exec, and metrics cadence at the context boundary', () => {
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

test('imports all six ECR images by exact digest and keeps ADOT as the only Docker asset', () => {
  const stack = createStack();
  expect(stack.node.tryFindChild('AdotImage')).toBeInstanceOf(ecrAssets.DockerImageAsset);
  template.resourceCountIs('AWS::ECR::Repository', 0);

  for (const input of APPLICATION_COMPONENT_INPUTS) {
    const definition = container(template, `movie-${input.componentId}`);
    const renderedImage = JSON.stringify(definition.Image);
    expect(renderedImage).toContain(input.repositoryName);
    expect(renderedImage).toContain(TEST_DIGEST);
  }
});

test('creates the no-NAT private workload network and required AWS endpoints', () => {
  template.resourceCountIs('AWS::EC2::NatGateway', 0);
  template.resourceCountIs('AWS::EC2::Subnet', 4);
  template.resourceCountIs('AWS::EC2::InternetGateway', 1);
  const endpointServices = resources(template, 'AWS::EC2::VPCEndpoint').map(
    ({ Properties }) => Properties?.ServiceName,
  );
  for (const suffix of ['ecr.api', 'ecr.dkr', 'logs', 'xray', 'aps-workspaces', 'sts']) {
    expect(JSON.stringify(endpointServices)).toContain(suffix);
  }
});

test('creates one 2-vCPU/4-GiB task with six essential apps and nonessential ADOT', () => {
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    Cpu: '2048',
    Memory: '4096',
    NetworkMode: 'awsvpc',
  });
  const definitions = containers(template);
  expect(definitions).toHaveLength(7);
  expect(definitions.map(({ Name }) => Name).sort()).toEqual(
    [
      'adot-collector',
      'movie-recommendation-mcp',
      'movie-recommendation-service',
      'movie-reservation-agent',
      'movie-reservation-mcp',
      'movie-reservation-service',
      'movie-reservation-web',
    ].sort(),
  );
  expect(definitions.filter(({ Essential }) => Essential).length).toBe(6);
  expect(container(template, 'adot-collector')).toMatchObject({
    Essential: false,
    RestartPolicy: { Enabled: true, RestartAttemptPeriod: 60 },
  });
  for (const name of definitions.filter(({ Essential }) => Essential).map(({ Name }) => Name)) {
    expect(container(template, name).HealthCheck).toMatchObject({
      Interval: 15,
      Retries: 5,
      StartPeriod: 20,
      Timeout: 5,
    });
  }
});

test('uses the health commands supported by the six published runtime images', () => {
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
    'CMD-SHELL',
    'curl -fsS http://127.0.0.1:8091/health || exit 1',
  ]);
  expect(container(template, 'movie-recommendation-mcp').HealthCheck?.Command).toEqual([
    'CMD-SHELL',
    'curl -fsS http://127.0.0.1:8092/health || exit 1',
  ]);
  expect(container(template, 'movie-reservation-agent').HealthCheck?.Command).toEqual([
    'CMD-SHELL',
    'curl -fsS http://127.0.0.1:8080/health || exit 1',
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

test('wires task-local URLs, deterministic behavior, faults, versions, and distinct OTLP receivers', () => {
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
  expect(environment(container(template, 'movie-reservation-mcp'))).not.toHaveProperty(
    'OTEL_EXPORTER_OTLP_ENDPOINT',
  );
});

test('uses health-gated API-to-MCP-to-agent-to-web startup dependencies', () => {
  const dependency = (name: string, upstream: string, condition = 'HEALTHY') =>
    expect(container(template, name).DependsOn).toContainEqual({
      ContainerName: upstream,
      Condition: condition,
    });

  dependency('movie-reservation-service', 'adot-collector');
  dependency('movie-recommendation-service', 'adot-collector');
  dependency('movie-reservation-mcp', 'movie-reservation-service');
  dependency('movie-recommendation-mcp', 'movie-recommendation-service');
  dependency('movie-reservation-agent', 'movie-reservation-mcp');
  dependency('movie-reservation-agent', 'movie-recommendation-mcp');
  dependency('movie-reservation-web', 'movie-reservation-agent');
  dependency('movie-reservation-web', 'movie-reservation-service');
});

test('exposes only web port 8088 through the prefix-list-restricted ALB', () => {
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

test('uses separate disposable one-week logs for every component, ADOT, metrics, and Container Insights', () => {
  const logGroups = resources(template, 'AWS::Logs::LogGroup');
  expect(logGroups).toHaveLength(9);
  const names = logGroups.map(({ Properties }) => Properties?.LogGroupName);
  for (const component of APPLICATION_COMPONENT_INPUTS) {
    expect(names).toContain(`/movie-platform/aws-demo/${component.componentId}/app`);
  }
  expect(names).toEqual(
    expect.arrayContaining([
      '/movie-platform/aws-demo/adot',
      '/movie-platform/aws-demo/metrics',
      '/aws/ecs/containerinsights/movie-reservation-platform-aws-demo/performance',
    ]),
  );
  for (const logGroup of logGroups) {
    expect(logGroup.Properties?.RetentionInDays).toBe(7);
    expect(logGroup.DeletionPolicy).toBe('Delete');
  }
  expect(new Set(containers(template).map(({ LogConfiguration }) => LogConfiguration?.Options?.['awslogs-group']).filter(Boolean)).size).toBe(7);
});

test('keeps Grafana read-only while granting approved AMP, metric, bounded log, and X-Ray reads', () => {
  template.hasResourceProperties('AWS::Grafana::Workspace', {
    AccountAccessType: 'CURRENT_ACCOUNT',
    DataSources: ['CLOUDWATCH', 'PROMETHEUS', 'XRAY'],
    PermissionType: 'CUSTOMER_MANAGED',
  });
  const policies = resources(template, 'AWS::IAM::Policy');
  const grafanaPolicy = policies.find(({ Properties }) =>
    String(Properties?.PolicyName).includes('GrafanaDataAccessPolicy'),
  );
  const document = grafanaPolicy?.Properties?.PolicyDocument as {
    readonly Statement: Array<{ readonly Action: string | string[]; readonly Resource: unknown }>;
  };
  const allActions = document.Statement.flatMap(actions);
  expect(allActions).toEqual(
    expect.arrayContaining([
      'aps:QueryMetrics',
      'cloudwatch:GetMetricData',
      'logs:StartQuery',
      'logs:GetQueryResults',
      'xray:BatchGetTraces',
      'xray:GetTraceSummaries',
    ]),
  );
  expect(allActions.some((action) => /Put|Create|Delete|Update/.test(action))).toBe(false);
  const scopedLogs = document.Statement.find(({ Action }) => actions({ Action }).includes('logs:StartQuery'));
  expect(JSON.stringify(scopedLogs?.Resource)).toContain('/movie-platform/aws-demo/reservation-agent/app');
  expect(scopedLogs?.Resource).not.toBe('*');
  const xray = document.Statement.find(({ Action }) => actions({ Action }).includes('xray:BatchGetTraces'));
  expect(xray?.Resource).toBe('*');
});

test('task role can export telemetry but application images cannot mutate AWS', () => {
  const policies = resources(template, 'AWS::IAM::Policy');
  const taskPolicy = policies.find(({ Properties }) =>
    String(Properties?.PolicyName).includes('TaskRoleDefaultPolicy'),
  );
  const rendered = JSON.stringify(taskPolicy?.Properties?.PolicyDocument);
  expect(rendered).toContain('xray:PutTraceSegments');
  expect(rendered).toContain('aps:RemoteWrite');
  expect(rendered).toContain('logs:PutLogEvents');
  expect(rendered).not.toContain('ecr:PutImage');
  expect(rendered).not.toContain('ecs:UpdateService');
});

test('enables ECS Exec and its endpoint only when explicitly requested', () => {
  expect(JSON.stringify(template.toJSON())).not.toContain('ssmmessages:CreateControlChannel');
  const enabled = synthesized({ enableEcsExec: true });
  enabled.hasResourceProperties('AWS::ECS::Service', { EnableExecuteCommand: true });
  expect(JSON.stringify(enabled.toJSON())).toContain('ssmmessages:CreateControlChannel');
  expect(JSON.stringify(enabled.toJSON())).toContain('ssmmessages');
});

test('publishes deployment, telemetry, and per-component log discovery outputs', () => {
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
