import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AwsCliSandboxCloud } from '../src/aws-cli';
import { checkPrivatePath, readRecord, saveRecord } from '../src/record-file';
import { withRecordLock } from '../src/record-lock';
import { renderSandboxConfig } from '../src/render-config';
import { sampleRecord } from '../src/sample';
import { runCli } from '../src/cli';
import {
  allocationBlockers,
  admissionBlockers,
  parseSandboxRecord,
} from '@movie-platform/experiment-sandbox';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sandbox-operator-test-'));
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

test('prepare creates outside-Git mode0600 record, preserves existing records, local checks expose blockers', async () => {
  const path = join(directory, 'record.json');
  const messages: string[] = [];

  expect(await runCli(['prepare', '--record', path], (message) => messages.push(message))).toBe(0);
  expect(statSync(path).mode & 0o777).toBe(0o600);

  const before = readFileSync(path, 'utf8');

  await expect(runCli(['prepare', '--record', path], () => {})).rejects.toThrow();
  expect(readFileSync(path, 'utf8')).toBe(before);

  expect(await runCli(['check', '--record', path], (message) => messages.push(message))).toBe(2);

  expect(messages.join('')).toContain('zero-charge');
  expect(await runCli(['create', '--record', path], (message) => messages.push(message))).toBe(0);
  expect(messages.join('')).toContain('has not executed');
});

test('symlink and repository paths rejected; concurrent lock never admits a second operation', async () => {
  const path = join(directory, 'record.json');

  saveRecord(path, sampleRecord(new Date()), true);
  symlinkSync(path, join(directory, 'link.json'));

  expect(() => readRecord(join(directory, 'link.json'))).toThrow();
  expect(() => checkPrivatePath(join(process.cwd(), 'operator-record.json'))).toThrow(/Git/);

  await withRecordLock(path, async () => {
    await expect(withRecordLock(path, async () => undefined)).rejects.toThrow();
  });
});

test('nested unknown keys cannot smuggle credential fields', () => {
  const record = sampleRecord(new Date());

  expect(() =>
    parseSandboxRecord({ ...record, account: { ...record.account, token: 'credential' } }),
  ).toThrow(/unknown/);
});

test('each prerequisite is independent and cost above allowance fails even with complete evidence', () => {
  const now = new Date('2026-10-24T10:00:00Z');
  const timestamp = now.toISOString();
  const record = sampleRecord(now);

  const approved = {
    ...record,
    account: {
      ...record.account,
      state: 'ready' as const,
      accountId: '222222222222',
      capacityVerifiedAt: timestamp,
      capacityEvidence: 'operator capacity review',
      recoveryVerifiedAt: timestamp,
      recoveryEvidence: 'verified trusted status reconciliation scheduler',
    },
    sandboxTargetFile: '/private/sandbox-target.json',
    images: {
      ...record.images,
      verifiedAt: timestamp,
      verificationEvidence: 'same 60 samples/60s check both digests',
    },
    entitlement: {
      zeroCharge: true,
      expiresAt: record.lease.expiresAt,
      verifiedAt: timestamp,
      evidence: 'zero-charge supported features',
    },
    cost: {
      ...record.cost,
      complete: true,
      forecastAt: timestamp,
      evidence: 'complete current regional worksheet',
    },
    inventory: {
      ...record.inventory,
      stackName: 'trial-workloads',
      controlStackName: 'trial-control',
      cleanupInstalled: true,
      cleanupVerified: true,
    },
  };

  expect(admissionBlockers(approved, now)).toEqual([]);

  expect(
    allocationBlockers({ ...approved, cost: { ...approved.cost, operatingUsd: 8.01 } }, now).join(
      '',
    ),
  ).toContain('forecast');

  expect(
    admissionBlockers(
      { ...approved, inventory: { ...approved.inventory, cleanupVerified: false } },
      now,
    ).join(''),
  ).toContain('cleanup');

  expect(admissionBlockers(approved, new Date('2026-10-24T13:00:00Z')).join('')).toContain(
    'rejects',
  );

  expect(() =>
    parseSandboxRecord({ ...approved, lease: { ...approved.lease, maxConcurrentTasks: 5 } }),
  ).toThrow(/caps/);

  expect(() =>
    parseSandboxRecord({ ...approved, images: { ...approved.images, bad: approved.images.good } }),
  ).toThrow(/distinct/);
});

test('permissions beyond mode0600 rejected', () => {
  const path = join(directory, 'record.json');

  writeFileSync(path, JSON.stringify(sampleRecord(new Date())), { mode: 0o644 });

  expect(() => readRecord(path)).toThrow(/0600/);
});

test('render config derives exact target/image/lease fields and rejects credential or override fields', async () => {
  const base = sampleRecord(new Date());

  const record = {
    ...base,
    account: { ...base.account, state: 'ready' as const, accountId: '222222222222' },
  };

  const inputs = {
    allowedIngressCidrs: ['192.0.2.1/32'],
    toolsImage: record.images.good,
    delegateImage: record.images.bad,
    delegateTokenSecretArn: `arn:aws:secretsmanager:eu-central-1:222222222222:secret:experiment/${record.id}/delegate-ABCDEF`,
    harnessAccountId: 'scratch-account',
    harnessManagerUrl: 'https://app.harness.io',
  };

  expect(renderSandboxConfig(record, inputs)).toMatchObject({
    experimentId: record.id,
    accountId: '222222222222',
    goodImage: record.images.good,
    launchCutoffAt: record.lease.rejectNewWorkAt,
  });

  expect(() => renderSandboxConfig(record, { ...inputs, accountId: '999999999999' })).toThrow(
    /inputs contains unknown key accountId/,
  );

  expect(() => renderSandboxConfig(record, { ...inputs, token: 'secret' })).toThrow(
    /inputs contains unknown key token/,
  );
});

test('runtime account state requires a string, never an array coercible to a known state', () => {
  const base = sampleRecord(new Date());

  expect(() =>
    parseSandboxRecord({ ...base, account: { ...base.account, state: ['ready'] } }),
  ).toThrow(/account.state/);
});

test('cleanup execution summary and later inspect preserve actionable blockers', async () => {
  const cleanup = jest.spyOn(AwsCliSandboxCloud.prototype, 'cleanup').mockResolvedValue({
    status: 'BLOCKED',
    blockers: ['Workload provisioning is still active; retry cleanup'],
    resources: ['pending-resource'],
    accessRevoked: true,
    workloadsRemoved: false,
  });

  try {
    const path = join(directory, 'record.json');
    const base = sampleRecord(new Date());

    saveRecord(
      path,
      { ...base, account: { ...base.account, state: 'ready', accountId: '222222222222' } },
      true,
    );

    const messages: string[] = [];

    expect(
      await runCli(['cleanup', '--record', path, '--execute'], (message) => messages.push(message)),
    ).toBe(2);

    expect(messages.join('')).toContain('Workload provisioning is still active; retry cleanup');

    expect(await runCli(['inspect', '--record', path], (message) => messages.push(message))).toBe(
      0,
    );

    expect(messages.join('')).toContain('cleanupStatus');
  } finally {
    cleanup.mockRestore();
  }
});

test('persisted cleanup diagnostics require strict bounded status and string-array fields', () => {
  const base = sampleRecord(new Date());

  expect(() =>
    parseSandboxRecord({
      ...base,
      inventory: {
        ...base.inventory,
        cleanupStatus: 'BLOCKED',
        cleanupBlockers: ['Retry protected cleanup'],
      },
    }),
  ).not.toThrow();

  for (const fields of [
    { cleanupStatus: ['BLOCKED'] },
    { cleanupStatus: 'UNKNOWN' },
    { cleanupBlockers: ['a'.repeat(257)] },
    { cleanupBlockers: Array.from({ length: 21 }, () => 'blocker') },
    { cleanupBlockers: [3] },
  ]) {
    expect(() =>
      parseSandboxRecord({ ...base, inventory: { ...base.inventory, ...fields } }),
    ).toThrow(/cleanup/);
  }
});
