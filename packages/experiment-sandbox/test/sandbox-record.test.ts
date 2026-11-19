import {
  parseRetiredControls,
  parseSandboxRecord,
  type RetiredControls,
  type SandboxRecord,
} from '../src';
import { isoTimestampSchema } from '../src/field-schemas';
import { approvedRecord, hoursFromNow } from './approved-record';

const SANDBOX_ACCOUNT = '222222222222';
const REGION = 'eu-central-1';
const CONTROL_STACK = 'exp-policy-test-control';

const CONTROL_LOCATION = {
  accountId: SANDBOX_ACCOUNT,
  region: REGION,
  stackName: CONTROL_STACK,
} as const;

/** One rejected record: a single change and the error it must produce. */
interface RejectedRecordCase {
  readonly rule: string;
  readonly change: (record: SandboxRecord) => unknown;
  readonly error: RegExp;
}

describe('timestamps', () => {
  test.each(['2026-10-24T10:00:00Z', '2026-10-24T10:00:00.123Z', '2028-02-29T00:00:00Z'])(
    'accepts UTC timestamp %s',
    (value) => {
      expect(isoTimestampSchema.safeParse(value).success).toBe(true);
    },
  );

  test.each([
    ['no zone, read as local time', '2026-10-24T10:00:00'],
    ['a numeric offset', '2026-10-24T12:00:00+02:00'],
    ['an impossible date', '2026-02-30T00:00:00Z'],
    ['a date without time', '2026-10-24'],
  ])('rejects %s', (_reason, value) => {
    expect(isoTimestampSchema.safeParse(value).success).toBe(false);

    const record = approvedRecord();

    expect(() =>
      parseSandboxRecord({ ...record, lease: { ...record.lease, startsAt: value } }),
    ).toThrow(/lease\.startsAt: must be a UTC ISO 8601 timestamp/);
  });
});

const rejectedRecords: readonly RejectedRecordCase[] = [
  {
    rule: 'a lease longer than the limit',
    change: (record) => ({ ...record, lease: { ...record.lease, expiresAt: hoursFromNow(4.5) } }),
    error: /lease must expire within 4h and reject new work within 3h/,
  },
  {
    rule: 'a new-work cutoff later than the limit',
    change: (record) => ({
      ...record,
      lease: { ...record.lease, rejectNewWorkAt: hoursFromNow(3.5) },
    }),
    error: /lease must expire within 4h and reject new work within 3h/,
  },
  {
    rule: 'a lease that ends before it starts',
    change: (record) => ({ ...record, lease: { ...record.lease, expiresAt: hoursFromNow(-1) } }),
    error: /lease must expire within 4h/,
  },
  {
    rule: 'raised launch caps',
    change: (record) => ({ ...record, lease: { ...record.lease, maxTotalLaunches: 17 } }),
    error: /lease task\/runtime caps must be 4\/16\/45/,
  },
  {
    rule: 'a raised budget allowance',
    change: (record) => ({ ...record, cost: { ...record.cost, allowanceUsd: 11 } }),
    error: /cost\.allowanceUsd/,
  },
  {
    rule: 'another region',
    change: (record) => ({ ...record, region: 'us-east-1' }),
    error: /region/,
  },
  {
    rule: 'identical good and bad images',
    change: (record) => ({ ...record, images: { ...record.images, bad: record.images.good } }),
    error: /images require distinct immutable digest references/,
  },
  {
    rule: 'an image pinned by tag',
    change: (record) => ({ ...record, images: { ...record.images, bad: 'repository:latest' } }),
    error: /images require distinct immutable digest references/,
  },
  {
    rule: 'an account name without its correlation ID',
    change: (record) => ({ ...record, account: { ...record.account, name: 'exp-policy-test' } }),
    error: /account\.name: must end with unique correlationId/,
  },
  {
    rule: 'a ready account without an account ID',
    change: (record) => ({ ...record, account: { ...record.account, accountId: undefined } }),
    error: /account\.accountId: ready account requires accountId/,
  },
  {
    rule: 'the management account used as the sandbox',
    change: (record) => ({
      ...record,
      account: { ...record.account, accountId: record.managementAccountId },
    }),
    error: /sandbox account must differ from management account/,
  },
  {
    rule: 'a nested unknown key',
    change: (record) => ({ ...record, cost: { ...record.cost, apiKey: 'value' } }),
    error: /cost contains unknown key apiKey/,
  },
];

test.each(rejectedRecords)('rejects $rule', ({ change, error }) => {
  expect(() => parseSandboxRecord(change(approvedRecord()))).toThrow(error);
});

test('parsing returns a frozen copy', () => {
  const parsed = parseSandboxRecord(approvedRecord());

  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed.lease)).toBe(true);
});

/** A complete manifest of the control stack's retained resources. */
function capturedManifest(): RetiredControls {
  const capturedAt = hoursFromNow(0);

  return {
    stackId: `arn:aws:cloudformation:${REGION}:${SANDBOX_ACCOUNT}:stack/${CONTROL_STACK}/abc-123`,
    capturedAt,
    templateSha256: 'c'.repeat(64),
    resources: [
      {
        resourceClass: 'AWS::DynamoDB::Table',
        logicalId: 'State',
        physicalId: 'exp-policy-test-state',
        arn: `arn:aws:dynamodb:${REGION}:${SANDBOX_ACCOUNT}:table/exp-policy-test-state`,
      },
      {
        resourceClass: 'AWS::S3::Bucket',
        logicalId: 'Inventory',
        physicalId: 'exp-policy-test-inventory',
        arn: 'arn:aws:s3:::exp-policy-test-inventory',
      },
      {
        resourceClass: 'AWS::Logs::LogGroup',
        logicalId: 'CleanupLogs',
        physicalId: '/aws/lambda/exp-policy-test-cleanup',
        arn: `arn:aws:logs:${REGION}:${SANDBOX_ACCOUNT}:log-group:/aws/lambda/exp-policy-test-cleanup`,
      },
    ],
  };
}

describe('retired control manifest', () => {
  const parseManifest = (value: unknown) => parseRetiredControls(value, CONTROL_LOCATION);

  test('accepts a complete manifest for this account and stack', () => {
    expect(parseManifest(capturedManifest()).resources).toHaveLength(3);
  });

  test('rejects a manifest missing a required resource class', () => {
    const manifest = capturedManifest();

    const withoutLogs = {
      ...manifest,
      resources: [manifest.resources[0], manifest.resources[1], manifest.resources[1]],
    };

    expect(() => parseManifest(withoutLogs)).toThrow(/must include state table/);
  });

  test('rejects duplicate logical IDs', () => {
    const manifest = capturedManifest();
    const [table, bucket, logs] = manifest.resources;

    expect(() =>
      parseManifest({ ...manifest, resources: [table, bucket, { ...logs, logicalId: 'State' }] }),
    ).toThrow(/identity mismatch or duplicate/);
  });

  test('rejects verified absence without an observation for every resource', () => {
    expect(() =>
      parseManifest({ ...capturedManifest(), verifiedAbsentAt: hoursFromNow(1) }),
    ).toThrow(/verifiedAbsentAt: Control absence needs every resource observation/);
  });

  test('rejects a manifest captured in another account', () => {
    expect(() =>
      parseRetiredControls(capturedManifest(), { ...CONTROL_LOCATION, accountId: '333333333333' }),
    ).toThrow(/stackId does not match the control stack/);
  });

  test('rejects a resource ARN that does not match its physical ID', () => {
    const manifest = capturedManifest();
    const [table, bucket, logs] = manifest.resources;

    const movedBucket = { ...bucket, arn: 'arn:aws:s3:::someone-elses-bucket' };

    expect(() => parseManifest({ ...manifest, resources: [table, movedBucket, logs] })).toThrow(
      /identity mismatch or duplicate/,
    );
  });
});
