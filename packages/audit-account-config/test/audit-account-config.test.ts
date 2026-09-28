import {
  AuditAccountConfigError,
  parseAuditAccountConfigJson,
  type AuditAccountConfig,
} from '../src';

const VALID_CONFIG = {
  managementAccountId: '111111111111',
  auditAccountId: '222222222222',
  workloadAccountIds: ['333333333333'],
  region: 'eu-central-1',
} as const satisfies AuditAccountConfig;

function serialize(rawValue: unknown): string {
  return JSON.stringify(rawValue);
}

function expectInvalidConfig(rawValue: unknown): void {
  expect(() => parseAuditAccountConfigJson(serialize(rawValue))).toThrow(
    AuditAccountConfigError,
  );
}

describe('audit-account configuration', () => {
  test('accepts a valid account topology', () => {
    expect(parseAuditAccountConfigJson(serialize(VALID_CONFIG))).toEqual(
      VALID_CONFIG,
    );
  });

  test.each([
    [
      'identical audit and management accounts',
      {
        ...VALID_CONFIG,
        managementAccountId: VALID_CONFIG.auditAccountId,
      },
    ],
    [
      'a workload account that is also the management account',
      {
        ...VALID_CONFIG,
        workloadAccountIds: [VALID_CONFIG.managementAccountId],
      },
    ],
    [
      'duplicate workload accounts',
      {
        ...VALID_CONFIG,
        workloadAccountIds: ['333333333333', '333333333333'],
      },
    ],
    [
      'an empty workload-account list',
      {
        ...VALID_CONFIG,
        workloadAccountIds: [],
      },
    ],
    [
      'an unsupported Region',
      {
        ...VALID_CONFIG,
        region: 'us-east-1',
      },
    ],
    [
      'an unknown configuration key',
      {
        ...VALID_CONFIG,
        unexpectedKey: true,
      },
    ],
    [
      'a missing required key',
      {
        auditAccountId: VALID_CONFIG.auditAccountId,
        workloadAccountIds: VALID_CONFIG.workloadAccountIds,
        region: VALID_CONFIG.region,
      },
    ],
    [
      'a malformed account ID',
      {
        ...VALID_CONFIG,
        auditAccountId: 'not-an-account-id',
      },
    ],
  ])('rejects %s', (_scenario, invalidConfig) => {
    expectInvalidConfig(invalidConfig);
  });

  test('rejects invalid JSON', () => {
    expect(() => parseAuditAccountConfigJson('{')).toThrow(
      AuditAccountConfigError,
    );
  });

  test.each([
    ['an array', []],
    ['null', null],
  ])('rejects %s as the top-level value', (_scenario, invalidValue) => {
    expectInvalidConfig(invalidValue);
  });
});
