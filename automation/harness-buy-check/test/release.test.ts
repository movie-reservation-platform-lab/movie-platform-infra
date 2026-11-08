import { ReleaseObservation, ReleasePort, releaseCandidate } from '../src/release';

function setup(states: ReleaseObservation[], verdict: 'PASS' | 'FAIL' | 'PENDING' = 'PASS') {
  let now = 0;
  let index = 0;
  const calls: string[] = [];

  const original: ReleaseObservation = {
    state: 'COMPLETED',
    taskDefinitionArn: 'old:1',
    digest: 'old',
  };

  const port: ReleasePort = {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    watch: async () => ({ ready: true, heartbeatAt: now, alarmStates: { probe: 'OK' } }),
    alarms: async () => ({ probe: 'OK' }),
    register: async () => {
      calls.push('register');

      return 'new:2';
    },
    update: async () => {
      calls.push('update');
    },
    observe: async () => states[Math.min(index++, states.length - 1)],
    verdict: async () => verdict,
  };

  return { port, original, calls };
}

test('stale watcher and non-OK alarms block registration and update', async () => {
  for (const fault of ['watch', 'alarms'] as const) {
    const f = setup([]);

    if (fault === 'watch') {
      f.port.watch = async () => ({
        ready: true,
        heartbeatAt: -100000,
        alarmStates: { probe: 'OK' },
      });
    } else {
      f.port.alarms = async () => ({ probe: 'INSUFFICIENT_DATA' });
    }

    await expect(releaseCandidate(f.port, 'new', f.original)).rejects.toThrow();
    expect(f.calls).toEqual([]);
  }
});

test('completed candidate requires trusted probe PASS and observed candidate identity', async () => {
  const f = setup([{ state: 'COMPLETED', taskDefinitionArn: 'new:2', digest: 'new' }]);

  expect((await releaseCandidate(f.port, 'new', f.original)).outcome).toBe('PASS');
  expect(f.calls).toEqual(['register', 'update']);
});

test('active failure waits for ECS to revert original revision and records failure', async () => {
  const f = setup(
    [
      { state: 'ACTIVE', taskDefinitionArn: 'new:2', digest: 'new' },
      { state: 'REVERTED', taskDefinitionArn: 'old:1', digest: 'old' },
    ],
    'FAIL',
  );

  const result = await releaseCandidate(f.port, 'new', f.original);

  expect(result).toMatchObject({ outcome: 'FAIL', reverted: true });
  expect(f.calls).toEqual(['register', 'update']);
});

test('a failure after completion never performs automatic rollback', async () => {
  const f = setup([{ state: 'COMPLETED', taskDefinitionArn: 'new:2', digest: 'new' }], 'FAIL');

  expect((await releaseCandidate(f.port, 'new', f.original)).outcome).toBe('FAIL');
  expect(f.calls).toEqual(['register', 'update']);
});

test('missing probe verdict times out, cannot pass completed release', async () => {
  const f = setup([{ state: 'COMPLETED', taskDefinitionArn: 'new:2', digest: 'new' }], 'PENDING');

  expect((await releaseCandidate(f.port, 'new', f.original)).outcome).toBe('FAIL');
});

test('eventual service observation of original revision immediately after update waits for rollout', async () => {
  const f = setup([
    { state: 'REVERTED', taskDefinitionArn: 'old:1', digest: 'old' },
    { state: 'ACTIVE', taskDefinitionArn: 'new:2', digest: 'new' },
    { state: 'COMPLETED', taskDefinitionArn: 'new:2', digest: 'new' },
  ]);

  expect((await releaseCandidate(f.port, 'new', f.original)).outcome).toBe('PASS');
});

test('readiness lost after registration blocks the service update', async () => {
  const f = setup([]);
  let watchReads = 0;

  f.port.watch = async () => ({
    ready: ++watchReads === 1,
    heartbeatAt: 0,
    alarmStates: { probe: 'OK' },
  });

  await expect(releaseCandidate(f.port, 'new', f.original)).rejects.toThrow('watcher');
  expect(f.calls).toEqual(['register']);
});

test('an active probe failure cannot be erased by later passing probes', async () => {
  const f = setup([
    { state: 'ACTIVE', taskDefinitionArn: 'new:2', digest: 'new' },
    { state: 'COMPLETED', taskDefinitionArn: 'new:2', digest: 'new' },
  ]);

  let verdictReads = 0;

  f.port.verdict = async () => (++verdictReads === 1 ? 'FAIL' : 'PASS');

  expect(await releaseCandidate(f.port, 'new', f.original)).toMatchObject({
    outcome: 'FAIL',
    reverted: false,
    reason: 'candidate failure observed; completed release requires operator recovery',
  });
});

test('rollback without observed active failure does not claim verified reversion', async () => {
  const f = setup([
    { state: 'ACTIVE', taskDefinitionArn: 'new:2', digest: 'new' },
    { state: 'REVERTED', taskDefinitionArn: 'old:1', digest: 'old' },
  ]);

  expect(await releaseCandidate(f.port, 'new', f.original)).toMatchObject({
    outcome: 'FAIL',
    reverted: false,
    reason: 'revert lacks active failure or original revision evidence',
  });
});

test('completed deployment with a different image cannot pass', async () => {
  const f = setup([{ state: 'COMPLETED', taskDefinitionArn: 'new:2', digest: 'unexpected' }]);

  expect(await releaseCandidate(f.port, 'new', f.original)).toMatchObject({
    outcome: 'FAIL',
    reason: 'running candidate identity mismatch',
  });
});
