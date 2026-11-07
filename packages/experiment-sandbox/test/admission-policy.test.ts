import {
  admissionBlockers,
  allocationBlockers,
  assertAdmission,
  HOUR_MS,
  SANDBOX_LIMITS,
  type SandboxRecord,
} from '../src';
import { approvedRecord, hoursFromNow, NOW } from './approved-record';

/** One rule under test: a single change to an approved record and the blocker it causes. */
interface BlockerCase {
  readonly rule: string;
  readonly change: (record: SandboxRecord) => SandboxRecord;
  readonly blocker: string;
  readonly now?: Date;
}

const allocationCases: readonly BlockerCase[] = [
  {
    rule: 'a paid Harness plan',
    change: (record) => ({ ...record, entitlement: { ...record.entitlement, zeroCharge: false } }),
    blocker: 'zero-charge Harness entitlement verified through lease expiry required',
  },
  {
    rule: 'a free plan that ends before the lease',
    change: (record) => ({
      ...record,
      entitlement: { ...record.entitlement, expiresAt: hoursFromNow(3) },
    }),
    blocker: 'zero-charge Harness entitlement verified through lease expiry required',
  },
  {
    rule: 'unverified images',
    change: (record) => ({ ...record, images: { ...record.images, verifiedAt: undefined } }),
    blocker: 'good/bad immutable artifact pair verification evidence required',
  },
  {
    rule: 'operating spend above the limit',
    change: (record) => ({ ...record, cost: { ...record.cost, operatingUsd: 8.01 } }),
    blocker: 'complete forecast must fit $8 operating plus $2 contingency within $10',
  },
  {
    rule: 'contingency below the limit',
    change: (record) => ({ ...record, cost: { ...record.cost, contingencyUsd: 1.99 } }),
    blocker: 'complete forecast must fit $8 operating plus $2 contingency within $10',
  },
  {
    rule: 'an incomplete forecast',
    change: (record) => ({ ...record, cost: { ...record.cost, complete: false } }),
    blocker: 'complete forecast must fit $8 operating plus $2 contingency within $10',
  },
  {
    rule: 'missing recovery evidence',
    change: (record) => ({
      ...record,
      account: { ...record.account, recoveryEvidence: undefined },
    }),
    blocker: 'trusted independent account preparation recovery schedule evidence required',
  },
  {
    rule: 'missing capacity evidence',
    change: (record) => ({
      ...record,
      account: { ...record.account, capacityEvidence: undefined },
    }),
    blocker: 'organization capacity and target verification evidence required',
  },
  {
    rule: 'evidence older than the age limit',
    change: (record) => ({
      ...record,
      images: { ...record.images, verifiedAt: hoursFromNow(-25) },
    }),
    blocker: 'pre-allocation evidence must be current (within 24 hours)',
  },
  {
    rule: 'evidence dated in the future',
    change: (record) => ({ ...record, cost: { ...record.cost, forecastAt: hoursFromNow(1) } }),
    blocker: 'pre-allocation evidence must be current (within 24 hours)',
  },
  {
    rule: 'a passed account preparation deadline',
    change: (record) => ({
      ...record,
      account: { ...record.account, preparationExpiresAt: hoursFromNow(-1) },
    }),
    blocker: 'account preparation recovery deadline expired',
  },
  {
    rule: 'a reached new-work cutoff',
    change: (record) => record,
    now: new Date(NOW.getTime() + SANDBOX_LIMITS.maxNewWorkHours * HOUR_MS),
    blocker: 'lease rejects new work',
  },
];

const admissionOnlyCases: readonly BlockerCase[] = [
  {
    rule: 'an account that is not ready',
    change: (record) => ({ ...record, account: { ...record.account, state: 'requested' } }),
    blocker: 'ready dedicated sandbox account and target file required',
  },
  {
    rule: 'a missing sandbox target file',
    change: (record) => ({ ...record, sandboxTargetFile: undefined }),
    blocker: 'ready dedicated sandbox account and target file required',
  },
  {
    rule: 'a lease that has not started',
    change: (record) => ({
      ...record,
      lease: { ...record.lease, startsAt: hoursFromNow(1), rejectNewWorkAt: hoursFromNow(3) },
    }),
    blocker: 'lease has not started',
  },
  {
    rule: 'unverified cleanup',
    change: (record) => ({
      ...record,
      inventory: { ...record.inventory, cleanupVerified: false },
    }),
    blocker: 'independent cleanup must be installed and verified before admission',
  },
  {
    rule: 'revoked access',
    change: (record) => ({ ...record, inventory: { ...record.inventory, accessRevoked: true } }),
    blocker: 'finished sandbox cannot be readmitted',
  },
  {
    rule: 'removed workloads',
    change: (record) => ({ ...record, inventory: { ...record.inventory, workloadsRemoved: true } }),
    blocker: 'finished sandbox cannot be readmitted',
  },
];

test('an approved record has no blockers', () => {
  expect(allocationBlockers(approvedRecord(), NOW)).toEqual([]);
  expect(admissionBlockers(approvedRecord(), NOW)).toEqual([]);
  expect(() => assertAdmission(approvedRecord(), NOW)).not.toThrow();
});

test.each(allocationCases)('allocation and admission block $rule', (testCase) => {
  const record = testCase.change(approvedRecord());
  const now = testCase.now ?? NOW;

  expect(allocationBlockers(record, now)).toEqual([testCase.blocker]);
  expect(admissionBlockers(record, now)).toEqual([testCase.blocker]);
});

test.each(admissionOnlyCases)('admission alone blocks $rule', (testCase) => {
  const record = testCase.change(approvedRecord());

  expect(allocationBlockers(record, NOW)).toEqual([]);
  expect(admissionBlockers(record, NOW)).toEqual([testCase.blocker]);
});

test('an invalid record yields one blocker and no rule results', () => {
  const record = { ...approvedRecord(), token: 'secret' } as SandboxRecord;

  const blockers = admissionBlockers(record, NOW);

  expect(blockers).toHaveLength(1);
  expect(blockers[0]).toMatch(/^invalid record: record contains unknown key token/);
  expect(blockers[0]).not.toContain('secret');
});

test('an invalid clock blocks instead of comparing against NaN', () => {
  expect(allocationBlockers(approvedRecord(), new Date(Number.NaN))).toEqual([
    'invalid current time',
  ]);
});

test('assertAdmission joins every blocker into one error', () => {
  const record = approvedRecord();

  const finished = {
    ...record,
    sandboxTargetFile: undefined,
    inventory: { ...record.inventory, accessRevoked: true },
  };

  expect(() => assertAdmission(finished, NOW)).toThrow(
    'ready dedicated sandbox account and target file required; finished sandbox cannot be readmitted',
  );
});
