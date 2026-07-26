import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const SMOKE_SCRIPT = path.join(__dirname, '..', 'scripts', 'xray-smoke.sh');

interface SmokeReport {
  readonly result: 'success' | 'failure';
  readonly failure_stage: string | null;
  readonly traceparent: string;
  readonly xray_trace_id: string;
  readonly correlation_id: string;
  readonly request_id: string;
  readonly stack_name: string;
  readonly region: string;
  readonly target: string;
  readonly duration_ms: number;
}

test('converts a known W3C trace ID through the smoke self-test', () => {
  const result = spawnSync('bash', [SMOKE_SCRIPT, '--self-test'], {
    encoding: 'utf8',
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('X-Ray smoke helper self-test passed');
});

test('fails prerequisites before making a request when AWS_PROFILE is missing', () => {
  const fixture = createFixture(successfulCurl, emptyTraceAws);

  try {
    const result = runSmoke(fixture, { AWS_PROFILE: undefined });
    const report = parseReport(result.stdout);

    expect(result.status).toBe(1);
    expect(report).toMatchObject({
      result: 'failure',
      failure_stage: 'prerequisites',
    });
    expect(readFileSync(fixture.curlMarker, 'utf8')).toBe('');
  } finally {
    fixture.cleanup();
  }
});

test('rejects an invalid report destination before making a request', () => {
  const fixture = createFixture(successfulCurl, emptyTraceAws);

  try {
    const result = runSmoke(fixture, {}, ['--report', fixture.directory]);
    const report = parseReport(result.stdout);

    expect(result.status).toBe(1);
    expect(report).toMatchObject({
      result: 'failure',
      failure_stage: 'prerequisites',
    });
    expect(result.stderr).toContain('existing report path must be a writable regular file');
    expect(readFileSync(fixture.curlMarker, 'utf8')).toBe('');
  } finally {
    fixture.cleanup();
  }
});

test('reports HTTP and GraphQL failures as distinct stages', () => {
  const httpFixture = createFixture(failingCurl, emptyTraceAws);
  const graphQlFixture = createFixture(graphQlErrorCurl, emptyTraceAws);

  try {
    const httpResult = runSmoke(httpFixture);
    const graphQlResult = runSmoke(graphQlFixture);

    expect(parseReport(httpResult.stdout).failure_stage).toBe('http_request');
    expect(parseReport(graphQlResult.stdout).failure_stage).toBe('graphql_response');
  } finally {
    httpFixture.cleanup();
    graphQlFixture.cleanup();
  }
});

test('distinguishes an absent trace from a trace with the wrong service segment', () => {
  const absentTraceFixture = createFixture(successfulCurl, emptyTraceAws);
  const wrongServiceFixture = createFixture(successfulCurl, wrongServiceAws);

  try {
    const absentTraceResult = runSmoke(absentTraceFixture);
    const wrongServiceResult = runSmoke(wrongServiceFixture);

    expect(parseReport(absentTraceResult.stdout).failure_stage).toBe('trace_timeout');
    expect(parseReport(wrongServiceResult.stdout).failure_stage).toBe('service_segment_timeout');
  } finally {
    absentTraceFixture.cleanup();
    wrongServiceFixture.cleanup();
  }
}, 10_000);

test('writes a sanitized success report for the expected service segment', () => {
  const fixture = createFixture(successfulCurl, expectedServiceAws);
  const reportPath = path.join(fixture.directory, 'report.json');

  try {
    const result = runSmoke(fixture, {}, ['--report', reportPath]);
    const report = parseReport(result.stdout);

    expect(result.status).toBe(0);
    expect(report).toMatchObject({
      result: 'success',
      failure_stage: null,
      stack_name: 'GoldenPathDemoStack',
      region: 'eu-central-1',
      target: 'http://example.test',
    });
    expect(report.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(report.xray_trace_id).toMatch(/^1-[0-9a-f]{8}-[0-9a-f]{24}$/);
    expect(report.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(report.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(report.duration_ms).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toEqual(report);

    const serializedReport = JSON.stringify(report);
    expect(serializedReport).not.toContain('account');
    expect(serializedReport).not.toContain('user_id');
    expect(serializedReport).not.toContain('response');
  } finally {
    fixture.cleanup();
  }
});

interface SmokeFixture {
  readonly directory: string;
  readonly curlMarker: string;
  readonly cleanup: () => void;
}

function createFixture(curlScript: string, awsScript: string): SmokeFixture {
  const directory = mkdtempSync(path.join(tmpdir(), 'xray-smoke-'));
  const curlMarker = path.join(directory, 'curl-called');
  writeFileSync(curlMarker, '');
  writeExecutable(path.join(directory, 'curl'), curlScript);
  writeExecutable(path.join(directory, 'aws'), awsScript);

  return {
    directory,
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
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${fixture.directory}:${process.env.PATH ?? ''}`,
    AWS_PROFILE: 'test-profile',
    AWS_REGION: 'eu-central-1',
    XRAY_SMOKE_TIMEOUT_SECONDS: '1',
    XRAY_SMOKE_POLL_INTERVAL_SECONDS: '1',
    CURL_MARKER: fixture.curlMarker,
    ...envOverrides,
  };
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

function parseReport(stdout: string): SmokeReport {
  const reportLine = stdout
    .trim()
    .split('\n')
    .reverse()
    .find((line) => line.startsWith('{'));
  if (reportLine === undefined) {
    throw new Error(`smoke output did not contain a JSON report: ${stdout}`);
  }
  return JSON.parse(reportLine) as SmokeReport;
}

const successfulCurl = `#!/usr/bin/env bash
set -euo pipefail
printf called >"\${CURL_MARKER}"
output=''
while [[ \$# -gt 0 ]]; do
  if [[ "\$1" == '--output' ]]; then output="\$2"; shift 2; else shift; fi
done
printf '{"data":{"movies":[]}}' >"\${output}"
printf '200'
`;

const graphQlErrorCurl = `#!/usr/bin/env bash
set -euo pipefail
printf called >"\${CURL_MARKER}"
output=''
while [[ \$# -gt 0 ]]; do
  if [[ "\$1" == '--output' ]]; then output="\$2"; shift 2; else shift; fi
done
printf '{"errors":[{"message":"do not copy this response"}]}' >"\${output}"
printf '200'
`;

const failingCurl = `#!/usr/bin/env bash
printf called >"\${CURL_MARKER}"
exit 7
`;

const emptyTraceAws = `#!/usr/bin/env bash
printf '{"Traces":[]}'
`;

const wrongServiceAws = `#!/usr/bin/env bash
cat <<'JSON'
{"Traces":[{"Segments":[{"Document":"{\\"name\\":\\"another-service\\"}"}]}]}
JSON
`;

const expectedServiceAws = `#!/usr/bin/env bash
cat <<'JSON'
{"Traces":[{"Segments":[{"Document":"{\\"name\\":\\"movie-reservation-service\\"}"}]}]}
JSON
`;
