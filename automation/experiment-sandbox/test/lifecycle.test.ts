import {
  createAccount,
  cleanupSandbox,
  RequestNotSubmittedError,
  retireAccount,
  type SandboxCloud,
} from '../src/lifecycle';
import type { SandboxRecord } from '@movie-platform/experiment-sandbox';

function record(): SandboxRecord {
  return {
    account: { state: 'planned' },
    inventory: { resources: ['resource'], workloadsRemoved: false, accessRevoked: false },
  } as unknown as SandboxRecord;
}

function cloud(): jest.Mocked<SandboxCloud> {
  return {
    verifyCreate: jest.fn(),
    create: jest.fn(),
    reconcile: jest.fn(),
    admit: jest.fn(),
    cleanup: jest.fn(),
    captureControls: jest.fn(),
    finalizeControls: jest.fn(),
    verifyRetirement: jest.fn(),
    retire: jest.fn(),
    retirementStatus: jest.fn(),
  };
}

test('creation intent is durable before request; lost response becomes unknown and cannot create again', async () => {
  const aws = cloud();
  const writes: SandboxRecord[] = [];

  aws.create.mockImplementation(async () => {
    expect(writes.at(-1)?.account.state).toBe('submitting');

    throw new Error('response lost');
  });

  await expect(createAccount(record(), { save: (r) => writes.push(r) }, aws)).rejects.toThrow(
    /outcome unknown \(Error\); run status --execute/,
  );

  const unknown = writes.at(-1)!;

  expect(unknown.account.state).toBe('unknown');

  await expect(createAccount(unknown, { save: (r) => writes.push(r) }, aws)).rejects.toThrow(
    /reconcile/,
  );

  expect(aws.create).toHaveBeenCalledTimes(1);
});

test('a failed preflight saves nothing and keeps the account planned', async () => {
  const aws = cloud();
  const writes: SandboxRecord[] = [];

  aws.verifyCreate.mockRejectedValue(new RequestNotSubmittedError('wrong SSO target'));

  await expect(createAccount(record(), { save: (r) => writes.push(r) }, aws)).rejects.toThrow(
    'wrong SSO target',
  );

  expect(writes).toEqual([]);
  expect(aws.create).not.toHaveBeenCalled();
});

test('an explicit AWS rejection returns the record to planned, so create can be retried', async () => {
  const aws = cloud();
  const writes: SandboxRecord[] = [];

  aws.create.mockRejectedValue(new RequestNotSubmittedError('AWS rejected account creation'));

  await expect(createAccount(record(), { save: (r) => writes.push(r) }, aws)).rejects.toThrow(
    /rejected/,
  );

  expect(writes.map((saved) => saved.account.state)).toEqual(['submitting', 'planned']);
});

test('a timeout leaves the account unknown and names the error code, never its message', async () => {
  const aws = cloud();
  const writes: SandboxRecord[] = [];
  const timeout = Object.assign(new Error('secret account detail'), { code: 'ServiceException' });

  aws.create.mockRejectedValue(timeout);

  const failure = createAccount(record(), { save: (r) => writes.push(r) }, aws);

  await expect(failure).rejects.toThrow(/outcome unknown \(ServiceException\)/);
  await expect(failure).rejects.not.toThrow(/secret/);
  expect(writes.at(-1)?.account.state).toBe('unknown');
});

test('cleanup saves its result even when the Lambda reports many unknown blockers', async () => {
  const aws = cloud();
  const writes: SandboxRecord[] = [];

  aws.cleanup.mockResolvedValue({
    status: 'BLOCKED',
    blockers: Array.from({ length: 50 }, (_, index) => `raw error ${index}`),
    resources: ['resource'],
    accessRevoked: true,
    workloadsRemoved: false,
  });

  const ready = { ...record(), account: { ...record().account, state: 'ready' as const } };

  await cleanupSandbox(ready, { save: (r) => writes.push(r) }, aws, new Date());

  expect(writes.at(-1)?.inventory.cleanupBlockers).toEqual([
    'Cleanup reported an unrecognized blocker; inspect protected inventory and retry',
  ]);
});

test('accepted delete request is incomplete; actual observed absence and revoked access required', async () => {
  const aws = cloud();

  aws.cleanup.mockResolvedValue({
    status: 'DELETING',
    blockers: [],
    resources: ['resource'],
    accessRevoked: true,
    workloadsRemoved: false,
  });

  const ready = { ...record(), account: { ...record().account, state: 'ready' as const } };
  const result = await cleanupSandbox(ready, { save: () => {} }, aws, new Date());

  expect(result.inventory.workloadsRemoved).toBe(false);
  expect(result.inventory.accessRevoked).toBe(true);
});

test('retirement refuses incomplete workload cleanup and never calls close account', async () => {
  const aws = cloud();

  await expect(retireAccount(record(), { save: () => {} }, aws)).rejects.toThrow(/cleanup/);
  expect(aws.retire).not.toHaveBeenCalled();
});

test('complete response with leftovers cannot complete cleanup', async () => {
  const aws = cloud();

  aws.cleanup.mockResolvedValue({
    status: 'COMPLETE',
    resources: ['leftover'],
    blockers: [],
    accessRevoked: true,
    workloadsRemoved: true,
  });

  const ready = { ...record(), account: { ...record().account, state: 'ready' as const } };
  const result = await cleanupSandbox(ready, { save: () => {} }, aws, new Date());

  expect(result.inventory.workloadsRemoved).toBe(false);
});

test('accepted cleanup absence is saved, closure acknowledgement is distinct from closed', async () => {
  const aws = cloud();

  aws.cleanup.mockResolvedValue({
    status: 'COMPLETE',
    resources: [],
    blockers: [],
    accessRevoked: true,
    workloadsRemoved: true,
  });

  const ready = {
    ...record(),
    account: { ...record().account, state: 'ready' as const, accountId: '222222222222' },
  };

  const removed = await cleanupSandbox(ready, { save: () => {} }, aws, new Date());

  const cleaned = {
    ...removed,
    inventory: {
      ...removed.inventory,
      retiredControls: {
        stackId: 'synthetic',
        capturedAt: new Date().toISOString(),
        templateSha256: 'a'.repeat(64),
        resources: [],
        verifiedAbsentAt: new Date().toISOString(),
      },
    },
  };

  const writes: SandboxRecord[] = [];

  aws.retire.mockImplementation(async () => {
    expect(writes.at(-1)?.account.state).toBe('closure-intent');
  });

  const result = await retireAccount(cleaned, { save: (r) => writes.push(r) }, aws);

  expect(result.account.state).toBe('closure-requested');
});

test('failed retirement verification never records closure intent; ambiguous submitted closure cannot resubmit', async () => {
  const aws = cloud();
  const writes: SandboxRecord[] = [];

  const base = {
    ...record(),
    account: { ...record().account, state: 'ready' as const, accountId: '222222222222' },
    inventory: {
      ...record().inventory,
      resources: [],
      accessRevoked: true,
      workloadsRemoved: true,
      observedAt: new Date().toISOString(),
      retiredControls: {
        stackId: 'synthetic',
        capturedAt: new Date().toISOString(),
        templateSha256: 'a'.repeat(64),
        resources: [],
        verifiedAbsentAt: new Date().toISOString(),
      },
    },
  };

  aws.verifyRetirement.mockRejectedValueOnce(new Error('table remains'));

  await expect(retireAccount(base, { save: (r) => writes.push(r) }, aws)).rejects.toThrow(
    /remains/,
  );

  expect(writes).toHaveLength(0);
  expect(aws.retire).not.toHaveBeenCalled();

  aws.retire.mockRejectedValueOnce(new Error('response lost'));

  await expect(retireAccount(base, { save: (r) => writes.push(r) }, aws)).rejects.toThrow(/lost/);
  expect(writes.at(-1)?.account.state).toBe('closure-unknown');

  await expect(retireAccount(writes.at(-1)!, { save: (r) => writes.push(r) }, aws)).rejects.toThrow(
    /ready/,
  );

  expect(aws.retire).toHaveBeenCalledTimes(1);
});

test('cleanup persists actionable status and blockers while replacing unknown raw diagnostics', async () => {
  const aws = cloud();

  aws.cleanup.mockResolvedValue({
    status: 'BLOCKED',
    resources: ['resource'],
    accessRevoked: true,
    workloadsRemoved: false,
    blockers: [
      'Workload provisioning is still active; retry cleanup',
      'Authorization: Bearer private-token',
    ],
  });

  const ready = { ...record(), account: { ...record().account, state: 'ready' as const } };
  const save = jest.fn();
  const result = await cleanupSandbox(ready, { save }, aws, new Date());

  expect(result.inventory).toMatchObject({
    cleanupStatus: 'BLOCKED',
    cleanupBlockers: [
      'Workload provisioning is still active; retry cleanup',
      'Cleanup reported an unrecognized blocker; inspect protected inventory and retry',
    ],
  });

  expect(JSON.stringify(save.mock.calls)).not.toContain('private-token');
});
