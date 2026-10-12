import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunConfigError, loadDemoCredentials, parseRunConfig } from '../src/run-config';

const VALID = {
  schema: 'audit-transport-comparison-run/v1',
  endpoint: 'http://demo.example.test',
  allowInsecureHttp: true,
  credentialsFile: '/private/auth.json',
  workloadTargetFile: '/private/workload-target.json',
  auditTargetFile: '/private/audit-target.json',
  attempts: { accepted: 2, rejected: 1 },
  legacyStore: { workGroup: 'movie-platform-audit', database: 'movie_platform_audit', table: 'authentication' },
  securityLakeStore: { workGroup: 'movie-platform-audit-investigation', crawlerName: 'sl-crawler', refreshCatalog: true },
  deliveryHealth: {
    deadLetterQueueUrl: 'https://sqs.eu-central-1.amazonaws.com/222222222222/AuditAccountIngestion-dlq',
    alarmNamePrefix: 'AuditAccountIngestionStack-AuditDeliveryAlarms',
  },
  output: '/private/result.json',
};

function parse(overrides: Record<string, unknown>) {
  return () => parseRunConfig(JSON.stringify({ ...VALID, ...overrides }));
}

describe('parseRunConfig', () => {
  it('parses a complete run file and applies documented defaults', () => {
    const config = parseRunConfig(JSON.stringify(VALID));

    expect(config.endpoint.href).toBe('http://demo.example.test/');
    expect(config.loginPath).toBe('/audit-demo/reservation/login');
    expect(config.attempts).toEqual({ accepted: 2, rejected: 1 });
    expect(config).toMatchObject({ timeoutSeconds: 1200, pollIntervalSeconds: 30, catalogRefreshDelaySeconds: 90 });
  });

  it('requires an explicit opt-in for plain HTTP', () => {
    expect(parse({ allowInsecureHttp: undefined })).toThrow('must use https unless allowInsecureHttp is true');
    expect(parse({ endpoint: 'https://demo.example.test', allowInsecureHttp: undefined })).not.toThrow();
    expect(parse({ endpoint: 'http://user:pw@demo.example.test' })).toThrow('must not contain credentials');
  });

  it('rejects identifiers that could change the Athena SQL', () => {
    expect(parse({ legacyStore: { ...VALID.legacyStore, table: 'authentication; DROP TABLE x' } }))
      .toThrow('legacyStore.table has an unsupported format');
    expect(parse({ legacyStore: { ...VALID.legacyStore, database: 'Movie"Audit' } }))
      .toThrow('legacyStore.database has an unsupported format');
  });

  it('rejects wrong schemas, relative paths, and out-of-range numbers', () => {
    expect(parse({ schema: 'v0' })).toThrow('run file schema must be');
    expect(parse({ output: 'result.json' })).toThrow('output must be an absolute path');
    expect(parse({ attempts: { accepted: 0, rejected: 0 } })).toThrow('at least one login');
    expect(parse({ attempts: { accepted: 21 } })).toThrow('attempts.accepted must be an integer from 0 to 20');
    expect(parse({ pollIntervalSeconds: 120, timeoutSeconds: 60 })).toThrow('must not exceed timeoutSeconds');
    expect(parse({ deliveryHealth: { ...VALID.deliveryHealth, deadLetterQueueUrl: 'https://evil.test/q' } }))
      .toThrow('must be an SQS queue URL');
    expect(() => parseRunConfig('{')).toThrow(RunConfigError);
  });
});

describe('loadDemoCredentials', () => {
  const directory = mkdtempSync(join(tmpdir(), 'transport-comparison-'));

  it('reads an owner-only credentials file', () => {
    const path = join(directory, 'auth.json');
    writeFileSync(path, JSON.stringify({ username: 'demo-user', password: 'secret' }), { mode: 0o600 });

    expect(loadDemoCredentials(path)).toEqual({ username: 'demo-user', password: 'secret' });
  });

  it('refuses files readable by group or others without echoing their contents', () => {
    const path = join(directory, 'open-auth.json');
    writeFileSync(path, JSON.stringify({ username: 'demo-user', password: 'secret' }));
    chmodSync(path, 0o644);

    expect(() => loadDemoCredentials(path)).toThrow('must deny all group and other access');
    expect(() => loadDemoCredentials(path)).not.toThrow('secret');
  });
});
