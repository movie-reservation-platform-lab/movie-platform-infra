import { RUN_CONFIG_DEFAULTS, RunConfigError, parseRunConfig, queueUrlLocation } from '../../src/cli/run-config';

const VALID = {
  schema: 'audit-transport-comparison-run/v1',
  endpoint: 'http://demo.example.test',
  allowInsecureHttp: true,
  credentialsFile: '/private/auth.json',
  workloadTargetFile: '/private/workload-target.json',
  auditTargetFile: '/private/audit-target.json',
  legacyStore: { workGroup: 'movie-platform-audit', database: 'movie_platform_audit', table: 'authentication' },
  securityLakeStore: { workGroup: 'movie-platform-audit-investigation', crawlerName: 'sl-crawler' },
  deliveryHealth: {
    deadLetterQueueUrl: 'https://sqs.eu-central-1.amazonaws.com/222222222222/AuditAccountIngestion-dlq',
    alarmNamePrefix: 'AuditAccountIngestionStack-AuditDeliveryAlarms',
  },
  output: '/private/result.json',
};

const parse = (overrides: Record<string, unknown>) => () => parseRunConfig(JSON.stringify({ ...VALID, ...overrides }));

describe('parseRunConfig', () => {
  it('applies the documented defaults to optional fields', () => {
    const config = parseRunConfig(JSON.stringify(VALID));

    expect(config.loginUrl.href).toBe(`http://demo.example.test${RUN_CONFIG_DEFAULTS.loginPath}`);
    expect(config.settings).toEqual({
      attempts: RUN_CONFIG_DEFAULTS.attempts,
      timeoutSeconds: RUN_CONFIG_DEFAULTS.timeoutSeconds,
      pollIntervalSeconds: RUN_CONFIG_DEFAULTS.pollIntervalSeconds,
      refreshCatalog: false,
      catalogRefreshDelaySeconds: RUN_CONFIG_DEFAULTS.catalogRefreshDelaySeconds,
    });
  });

  it('requires an explicit opt-in for plain HTTP and keeps the login on the endpoint origin', () => {
    expect(parse({ allowInsecureHttp: undefined })).toThrow('must use https unless allowInsecureHttp is true');
    expect(parse({ endpoint: 'https://demo.example.test', allowInsecureHttp: undefined })).not.toThrow();
    expect(parse({ endpoint: 'http://user:pw@demo.example.test' })).toThrow('must not contain credentials');
    expect(parse({ loginPath: '//evil.example.test/login' })).toThrow('loginPath has an unsupported format');
  });

  it.each([
    ['an SQL-bearing table', { legacyStore: { ...VALID.legacyStore, table: 'authentication; DROP TABLE x' } }, 'legacyStore.table has an unsupported format'],
    ['a quoted database', { legacyStore: { ...VALID.legacyStore, database: 'Movie"Audit' } }, 'legacyStore.database has an unsupported format'],
    ['a wrong schema', { schema: 'v0' }, 'run file schema must be'],
    ['a relative output', { output: 'result.json' }, 'output must be an absolute path'],
    ['zero logins', { attempts: { accepted: 0, rejected: 0 } }, 'at least one login'],
    ['too many logins', { attempts: { accepted: 21 } }, 'attempts.accepted must be an integer from 0 to 20'],
    ['a poll longer than the timeout', { pollIntervalSeconds: 120, timeoutSeconds: 60 }, 'must not exceed timeoutSeconds'],
    ['a non-SQS DLQ URL', { deliveryHealth: { ...VALID.deliveryHealth, deadLetterQueueUrl: 'https://evil.test/q' } }, 'deadLetterQueueUrl has an unsupported format'],
  ])('rejects %s', (_label, overrides, message) => {
    expect(parse(overrides)).toThrow(message);
  });

  it('rejects malformed JSON with a typed error', () => {
    expect(() => parseRunConfig('{')).toThrow(RunConfigError);
  });

  it('reads the account and Region from the DLQ URL', () => {
    expect(queueUrlLocation(VALID.deliveryHealth.deadLetterQueueUrl)).toEqual({ region: 'eu-central-1', accountId: '222222222222' });
  });
});
