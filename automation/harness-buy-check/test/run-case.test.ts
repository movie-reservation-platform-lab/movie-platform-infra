import { LaunchRequest, LaunchStatus, runCase, Scheduler } from '../src/run-case';

function fake(
  gate: 'SUCCEEDED' | 'FAILED' = 'SUCCEEDED',
  release: 'SUCCEEDED' | 'FAILED' = 'SUCCEEDED',
) {
  let now = 0;
  const calls: LaunchRequest[] = [];

  const scheduler: Scheduler = {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    invoke: async (request): Promise<LaunchStatus> => {
      calls.push(request);

      return {
        ...request,
        taskArn: 'arn:observed-task',
        status: request.stepId === 'gate' ? gate : request.stepId === 'watch' ? 'RUNNING' : release,
      };
    },
  };

  return { scheduler, calls };
}

test('gate failure prevents watch and release tasks', async () => {
  const f = fake('FAILED');
  const result = await runCase('blocked', 'experiment-test', f.scheduler);

  expect(result.outcome).toBe('FAIL');
  expect(f.calls.map((c) => c.stepId)).toEqual(['gate']);
});

test('good schedules gate then watch then release', async () => {
  const f = fake();

  expect((await runCase('good', 'experiment-test', f.scheduler)).outcome).toBe('PASS');
  expect(f.calls.map((c) => c.stepId)).toEqual(['gate', 'watch', 'release']);
});

test.each(['FAILED', 'SUCCEEDED'] as const)(
  'watch status %s prevents release because the watcher must remain running',
  async (watchStatus) => {
    const f = fake();

    f.scheduler.invoke = async (request) => {
      f.calls.push(request);

      return {
        ...request,
        status: request.stepId === 'watch' ? watchStatus : 'SUCCEEDED',
      };
    };

    expect(await runCase('good', 'experiment-test', f.scheduler)).toMatchObject({
      outcome: 'FAIL',
      releaseLaunched: false,
      reason: 'watch failed',
    });

    expect(f.calls.map((call) => call.stepId)).toEqual(['gate', 'watch']);
  },
);

test('bad remains failure when ECS release task fails; case name cannot invert live failure', async () => {
  const f = fake('SUCCEEDED', 'FAILED');

  expect((await runCase('bad', 'experiment-test', f.scheduler)).outcome).toBe('FAIL');
});

test('untrusted or mismatched launcher status fails closed', async () => {
  const f = fake();

  f.scheduler.invoke = async (r) => ({ ...r, experimentId: 'forged', status: 'SUCCEEDED' });

  await expect(runCase('good', 'experiment-test', f.scheduler)).rejects.toThrow();
});

test('pending launcher never becomes green and bounded waiter stops', async () => {
  const f = fake();

  f.scheduler.invoke = async (r) => ({ ...r, status: 'PENDING' });
  const result = await runCase('good', 'experiment-test', f.scheduler);

  expect(result.outcome).toBe('FAIL');
  expect(f.scheduler.now()).toBeLessThanOrEqual(45 * 60000);
});

test.each(['FAILED', 'PENDING'] as const)(
  'release %s without an observed task never claims a launch',
  async (releaseStatus) => {
    const f = fake();

    f.scheduler.invoke = async (request) => ({
      ...request,
      status:
        request.stepId === 'gate'
          ? 'SUCCEEDED'
          : request.stepId === 'watch'
            ? 'RUNNING'
            : releaseStatus,
    });

    const result = await runCase('good', 'experiment-test', f.scheduler);

    expect(result.outcome).toBe('FAIL');
    expect(result.releaseLaunched).toBe(false);
  },
);

test('release timeout preserves a task observed before the deadline', async () => {
  const f = fake();

  f.scheduler.invoke = async (request) => ({
    ...request,
    taskArn: 'arn:observed-task',
    status:
      request.stepId === 'gate' ? 'SUCCEEDED' : request.stepId === 'watch' ? 'RUNNING' : 'PENDING',
  });

  const result = await runCase('good', 'experiment-test', f.scheduler);

  expect(result.outcome).toBe('FAIL');
  expect(result.releaseLaunched).toBe(true);
});

test('release success without task identity is incomplete evidence', async () => {
  const f = fake();

  f.scheduler.invoke = async (request) => ({
    ...request,
    status: request.stepId === 'watch' ? 'RUNNING' : 'SUCCEEDED',
  });

  const result = await runCase('good', 'experiment-test', f.scheduler);

  expect(result.outcome).toBe('FAIL');
  expect(result.releaseLaunched).toBe(false);
});
