import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const SMOKE_SCRIPT = path.join(__dirname, '..', 'scripts', 'managed-metrics-smoke.sh');

interface ManagedMetricsSmokeReport {
  readonly result: 'success' | 'failure';
  readonly failure_stage: string | null;
  readonly stack_name: string;
  readonly region: string;
  readonly target: string;
  readonly metrics_namespace: string;
  readonly metric_name: string;
  readonly reservation_attempts: number;
  readonly confirmed_outcomes: number;
  readonly negative_outcomes: number;
  readonly cloudwatch_datapoint_count: number;
  readonly amp_application_series_count: number;
  readonly amp_ecs_task_series_count: number;
  readonly amp_container_series_count: number;
  readonly container_insights_task_datapoint_count: number;
  readonly container_insights_container_datapoint_count: number;
  readonly duration_ms: number;
}

test('validates response parsers through the managed metrics self-test', () => {
  const result = spawnSync('bash', [SMOKE_SCRIPT, '--self-test'], {
    encoding: 'utf8',
    env: withNodeOnPath(process.env),
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Managed metrics smoke helper self-test passed');
});

test('fails prerequisites before AWS or GraphQL calls when AWS_PROFILE is missing', () => {
  const fixture = createFixture(successfulAws, successfulCurl);

  try {
    const result = runSmoke(fixture, { AWS_PROFILE: undefined });
    const report = parseReport(result);

    expect(result.status).toBe(1);
    expect(report.failure_stage).toBe('prerequisites');
    expect(readFileSync(fixture.awsMarker, 'utf8')).toBe('');
    expect(readFileSync(fixture.awscurlMarker, 'utf8')).toBe('');
    expect(readFileSync(fixture.curlMarker, 'utf8')).toBe('');
  } finally {
    fixture.cleanup();
  }
});

test('reports a missing CloudWatch namespace output before generating traffic', () => {
  const fixture = createFixture(missingOutputsAws, successfulCurl);

  try {
    const result = runSmoke(fixture);
    const report = parseReport(result);

    expect(result.status).toBe(1);
    expect(report.failure_stage).toBe('stack_output');
    expect(result.stderr).toContain('no CloudWatch application metrics namespace output');
    expect(readFileSync(fixture.awscurlMarker, 'utf8')).toBe('');
    expect(readFileSync(fixture.curlMarker, 'utf8')).toBe('');
  } finally {
    fixture.cleanup();
  }
});

test('writes a sanitized dual-route success report with AMP and Container Insights evidence', () => {
  const fixture = createFixture(successfulAws, successfulCurl);
  const reportPath = path.join(fixture.directory, 'report.json');

  try {
    const result = runSmoke(fixture, {}, ['--report', reportPath]);
    const report = parseReport(result);

    expect(result.status).toBe(0);
    expect(report).toMatchObject({
      result: 'success',
      failure_stage: null,
      stack_name: 'GoldenPathDemoStack',
      region: 'eu-central-1',
      target: 'http://example.test',
      metrics_namespace: 'GoldenPath/aws-demo/movie-reservation-service',
      metric_name: 'graphql_operation_total',
      reservation_attempts: 2,
      confirmed_outcomes: 1,
      negative_outcomes: 1,
      cloudwatch_datapoint_count: 2,
      amp_application_series_count: 1,
      amp_ecs_task_series_count: 4,
      amp_container_series_count: 4,
      container_insights_task_datapoint_count: 2,
      container_insights_container_datapoint_count: 2,
    });
    expect(report.duration_ms).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toEqual(report);

    const serializedReport = JSON.stringify(report);
    expect(serializedReport).not.toContain('request-1');
    expect(serializedReport).not.toContain('seat-1');
    expect(serializedReport).not.toContain('response');

    const awscurlArguments = readFileSync(fixture.awscurlArguments, 'utf8');
    expect(awscurlArguments).toContain('--profile\ntest-profile');
    expect(awscurlArguments).toContain('--region\neu-central-1');
    expect(awscurlArguments).toContain('--service\naps');
    expect(awscurlArguments).toContain(
      'https://aps-workspaces.eu-central-1.amazonaws.com/workspaces/ws-test/api/v1/query',
    );
    expect(awscurlArguments).not.toContain('AWS_ACCESS_KEY_ID');
    expect(awscurlArguments).not.toContain('AWS_SECRET_ACCESS_KEY');
  } finally {
    fixture.cleanup();
  }
});

test('distinguishes a successful CloudWatch query from missing metric datapoints', () => {
  const fixture = createFixture(emptyMetricsAws, successfulCurl);

  try {
    const result = runSmoke(fixture, {
      MANAGED_METRICS_SMOKE_METRIC_TIMEOUT_SECONDS: '1',
    });
    const report = parseReport(result);

    expect(result.status).toBe(1);
    expect(report.failure_stage).toBe('cloudwatch_metric');
    expect(result.stderr).toContain('did not contain datapoints before timeout');
  } finally {
    fixture.cleanup();
  }
});

test('distinguishes a successful AMP query from an incomplete required metric set', () => {
  const fixture = createFixture(successfulAws, successfulCurl, emptyAmpAwscurl);

  try {
    const result = runSmoke(fixture, {
      MANAGED_METRICS_SMOKE_METRIC_TIMEOUT_SECONDS: '1',
    });
    const report = parseReport(result);

    expect(result.status).toBe(1);
    expect(report.failure_stage).toBe('amp_metric');
    expect(result.stderr).toContain('all eight ECS metrics before timeout');
  } finally {
    fixture.cleanup();
  }
});

test('rejects high-cardinality ECS identity labels returned by AMP', () => {
  const fixture = createFixture(successfulAws, successfulCurl, forbiddenLabelAwscurl);

  try {
    const result = runSmoke(fixture);
    const report = parseReport(result);

    expect(result.status).toBe(1);
    expect(report.failure_stage).toBe('amp_contract');
    expect(result.stderr).toContain('violated the metric label contract');
  } finally {
    fixture.cleanup();
  }
});

test('requires all four enhanced Container Insights metrics', () => {
  const fixture = createFixture(emptyContainerInsightsAws, successfulCurl);

  try {
    const result = runSmoke(fixture, {
      MANAGED_METRICS_SMOKE_METRIC_TIMEOUT_SECONDS: '1',
    });
    const report = parseReport(result);

    expect(result.status).toBe(1);
    expect(report.failure_stage).toBe('container_insights_metric');
    expect(result.stderr).toContain('all four enhanced Container Insights metrics');
  } finally {
    fixture.cleanup();
  }
});

interface SmokeFixture {
  readonly directory: string;
  readonly awsMarker: string;
  readonly awscurlMarker: string;
  readonly awscurlArguments: string;
  readonly curlMarker: string;
  readonly cleanup: () => void;
}

function createFixture(
  awsScript: string,
  curlScript: string,
  awscurlScript: string = successfulAwscurl,
): SmokeFixture {
  const directory = mkdtempSync(path.join(tmpdir(), 'managed-metrics-smoke-'));
  const awsMarker = path.join(directory, 'aws-called');
  const awscurlMarker = path.join(directory, 'awscurl-called');
  const awscurlArguments = path.join(directory, 'awscurl-arguments');
  const curlMarker = path.join(directory, 'curl-called');
  const requestCounter = path.join(directory, 'request-counter');
  writeFileSync(awsMarker, '');
  writeFileSync(awscurlMarker, '');
  writeFileSync(awscurlArguments, '');
  writeFileSync(curlMarker, '');
  writeFileSync(requestCounter, '0');
  writeExecutable(path.join(directory, 'aws'), awsScript);
  writeExecutable(path.join(directory, 'awscurl'), awscurlScript);
  writeExecutable(path.join(directory, 'curl'), curlScript);

  return {
    directory,
    awsMarker,
    awscurlMarker,
    awscurlArguments,
    curlMarker,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function writeExecutable(filePath: string, contents: string): void {
  writeFileSync(filePath, contents);
  chmodSync(filePath, 0o755);
}

function runSmoke(
  fixture: SmokeFixture,
  envOverrides: Readonly<Record<string, string | undefined>> = {},
  extraArguments: readonly string[] = [],
) {
  const env: NodeJS.ProcessEnv = withNodeOnPath({
    ...process.env,
    PATH: `${fixture.directory}:${process.env.PATH ?? ''}`,
    AWS_PROFILE: 'test-profile',
    AWS_REGION: 'eu-central-1',
    AWS_MARKER: fixture.awsMarker,
    AWSCURL_MARKER: fixture.awscurlMarker,
    AWSCURL_ARGUMENTS: fixture.awscurlArguments,
    CURL_MARKER: fixture.curlMarker,
    REQUEST_COUNTER: path.join(fixture.directory, 'request-counter'),
    MANAGED_METRICS_SMOKE_ATTEMPT_LIMIT: '3',
    MANAGED_METRICS_SMOKE_RESERVATION_TIMEOUT_SECONDS: '2',
    MANAGED_METRICS_SMOKE_POLL_INTERVAL_SECONDS: '1',
    MANAGED_METRICS_SMOKE_SETTLE_SECONDS: '0',
    MANAGED_METRICS_SMOKE_METRIC_TIMEOUT_SECONDS: '2',
    MANAGED_METRICS_SMOKE_METRIC_POLL_SECONDS: '1',
    ...envOverrides,
  });
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete env[key];
    }
  }

  return spawnSync('bash', [SMOKE_SCRIPT, '--base-url', 'http://example.test', ...extraArguments], {
    encoding: 'utf8',
    env,
  });
}

function withNodeOnPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    PATH: `${path.dirname(process.execPath)}:${env.PATH ?? ''}`,
  };
}

function parseReport(result: { readonly stdout: string; readonly stderr: string; readonly status: number | null }) {
  const reportLine = result.stdout
    .trim()
    .split('\n')
    .reverse()
    .find((line) => line.startsWith('{'));
  if (reportLine === undefined) {
    throw new Error(
      `smoke output did not contain a JSON report (status ${result.status}): ${result.stdout}\n${result.stderr}`,
    );
  }
  return JSON.parse(reportLine) as ManagedMetricsSmokeReport;
}

const stackOutputs = JSON.stringify([
  {
    OutputKey: 'LoadBalancerDnsName',
    OutputValue: 'example.test',
  },
  {
    OutputKey: 'CloudWatchApplicationMetricsNamespace',
    OutputValue: 'GoldenPath/aws-demo/movie-reservation-service',
  },
  {
    OutputKey: 'AmpPrometheusEndpoint',
    OutputValue: 'https://aps-workspaces.eu-central-1.amazonaws.com/workspaces/ws-test/api/v1/',
  },
  {
    OutputKey: 'EcsClusterName',
    OutputValue: 'movie-reservation-platform-aws-demo',
  },
  {
    OutputKey: 'EcsServiceName',
    OutputValue: 'movie-reservation-service',
  },
]);

const successfulAws = `#!/usr/bin/env bash
set -euo pipefail
printf called >"\${AWS_MARKER}"
if [[ "\${1:-}" == 'cloudformation' ]]; then
  printf '%s\\n' '${stackOutputs}'
elif [[ "\${1:-}" == 'cloudwatch' ]]; then
  if [[ " \$* " == *'taskCpu'* ]]; then
    printf '%s\\n' '{"MetricDataResults":[{"Id":"taskCpu","Values":[1]},{"Id":"taskMemory","Values":[1]},{"Id":"containerCpu","Values":[1]},{"Id":"containerMemory","Values":[1]}]}'
  else
    printf '%s\\n' '{"MetricDataResults":[{"Id":"applicationMetrics","Values":[2,1]}]}'
  fi
else
  exit 2
fi
`;

const missingOutputsAws = `#!/usr/bin/env bash
set -euo pipefail
printf called >"\${AWS_MARKER}"
printf '%s\\n' '[]'
`;

const emptyMetricsAws = `#!/usr/bin/env bash
set -euo pipefail
printf called >"\${AWS_MARKER}"
if [[ "\${1:-}" == 'cloudformation' ]]; then
  printf '%s\\n' '${stackOutputs}'
elif [[ "\${1:-}" == 'cloudwatch' ]]; then
  printf '%s\\n' '{"MetricDataResults":[{"Id":"applicationMetrics","Values":[]}]}'
else
  exit 2
fi
`;

const emptyContainerInsightsAws = `#!/usr/bin/env bash
set -euo pipefail
printf called >"\${AWS_MARKER}"
if [[ "\${1:-}" == 'cloudformation' ]]; then
  printf '%s\\n' '${stackOutputs}'
elif [[ "\${1:-}" == 'cloudwatch' ]]; then
  if [[ " \$* " == *'taskCpu'* ]]; then
    printf '%s\\n' '{"MetricDataResults":[{"Id":"taskCpu","Values":[]},{"Id":"taskMemory","Values":[]},{"Id":"containerCpu","Values":[]},{"Id":"containerMemory","Values":[]}]}'
  else
    printf '%s\\n' '{"MetricDataResults":[{"Id":"applicationMetrics","Values":[2,1]}]}'
  fi
else
  exit 2
fi
`;

const ampBaseLabels = {
  aws_ecs_cluster_name: 'movie-reservation-platform-aws-demo',
  aws_ecs_service_name: 'movie-reservation-service',
  aws_ecs_task_family: 'aws-demo-movie-reservation-service',
  cloud_region: 'eu-central-1',
};
const successfulAmpResponse = JSON.stringify({
  status: 'success',
  data: {
    result: [
      {
        metric: {
          __name__: 'graphql_operation_total',
          service_name: 'movie-reservation-service',
          deployment_environment: 'aws-demo',
        },
      },
      ...[
        'ecs_task_cpu_reserved',
        'ecs_task_cpu_utilized',
        'ecs_task_memory_reserved',
        'ecs_task_memory_utilized',
      ].map((metricName) => ({
        metric: { __name__: metricName, ...ampBaseLabels },
      })),
      ...[
        'container_cpu_reserved',
        'container_cpu_utilized',
        'container_memory_reserved',
        'container_memory_utilized',
      ].map((metricName) => ({
        metric: {
          __name__: metricName,
          ...ampBaseLabels,
          container_name: 'movie-reservation-service',
        },
      })),
    ],
  },
});

const forbiddenLabelAmpResponse = JSON.stringify({
  status: 'success',
  data: {
    result: [
      {
        metric: {
          __name__: 'ecs_task_cpu_reserved',
          ...ampBaseLabels,
          aws_ecs_task_id: 'task-identity-must-not-be-a-label',
        },
      },
    ],
  },
});

const successfulAwscurl = `#!/usr/bin/env bash
set -euo pipefail
printf called >"\${AWSCURL_MARKER}"
printf '%s\\n' "\$@" >"\${AWSCURL_ARGUMENTS}"
printf '%s\\n' '${successfulAmpResponse}'
`;

const emptyAmpAwscurl = `#!/usr/bin/env bash
set -euo pipefail
printf called >"\${AWSCURL_MARKER}"
printf '%s\\n' "\$@" >"\${AWSCURL_ARGUMENTS}"
printf '%s\\n' '{"status":"success","data":{"result":[]}}'
`;

const forbiddenLabelAwscurl = `#!/usr/bin/env bash
set -euo pipefail
printf called >"\${AWSCURL_MARKER}"
printf '%s\\n' "\$@" >"\${AWSCURL_ARGUMENTS}"
printf '%s\\n' '${forbiddenLabelAmpResponse}'
`;

const successfulCurl = `#!/usr/bin/env bash
set -euo pipefail
printf called >"\${CURL_MARKER}"
output=''
payload=''
while [[ \$# -gt 0 ]]; do
  case "\$1" in
    --output)
      output="\$2"
      shift 2
      ;;
    --data)
      payload="\$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

if [[ "\${payload}" == *'ManagedMetricsSmokeCatalog'* ]]; then
  printf '%s\\n' '{"data":{"screenings":[{"id":"screening-1","seats":[{"id":"seat-1"}]}]}}' >"\${output}"
elif [[ "\${payload}" == *'ManagedMetricsSmokeRequestReservation'* ]]; then
  count="\$((\$(cat "\${REQUEST_COUNTER}") + 1))"
  printf '%s' "\${count}" >"\${REQUEST_COUNTER}"
  printf '{"data":{"requestReservation":{"id":"request-%s","status":"REQUESTED"}}}\\n' "\${count}" >"\${output}"
elif [[ "\${payload}" == *'ManagedMetricsSmokeReservationStatus'* ]]; then
  if [[ "\${payload}" == *'request-1'* ]]; then status='CONFIRMED'; else status='FAILED'; fi
  printf '{"data":{"reservationRequestStatus":{"status":"%s"}}}\\n' "\${status}" >"\${output}"
else
  exit 2
fi

printf '200'
`;
