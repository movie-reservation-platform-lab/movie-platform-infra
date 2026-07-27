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
    expect(readFileSync(fixture.curlMarker, 'utf8')).toBe('');
  } finally {
    fixture.cleanup();
  }
});

test('writes a sanitized success report after bounded outcomes and a CloudWatch datapoint', () => {
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
    });
    expect(report.duration_ms).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toEqual(report);

    const serializedReport = JSON.stringify(report);
    expect(serializedReport).not.toContain('request-1');
    expect(serializedReport).not.toContain('seat-1');
    expect(serializedReport).not.toContain('response');
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

interface SmokeFixture {
  readonly directory: string;
  readonly awsMarker: string;
  readonly curlMarker: string;
  readonly cleanup: () => void;
}

function createFixture(awsScript: string, curlScript: string): SmokeFixture {
  const directory = mkdtempSync(path.join(tmpdir(), 'managed-metrics-smoke-'));
  const awsMarker = path.join(directory, 'aws-called');
  const curlMarker = path.join(directory, 'curl-called');
  const requestCounter = path.join(directory, 'request-counter');
  writeFileSync(awsMarker, '');
  writeFileSync(curlMarker, '');
  writeFileSync(requestCounter, '0');
  writeExecutable(path.join(directory, 'aws'), awsScript);
  writeExecutable(path.join(directory, 'curl'), curlScript);

  return {
    directory,
    awsMarker,
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
]);

const successfulAws = `#!/usr/bin/env bash
set -euo pipefail
printf called >"\${AWS_MARKER}"
if [[ "\${1:-}" == 'cloudformation' ]]; then
  printf '%s\\n' '${stackOutputs}'
elif [[ "\${1:-}" == 'cloudwatch' ]]; then
  printf '%s\\n' '{"MetricDataResults":[{"Id":"applicationMetrics","Values":[2,1]}]}'
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
