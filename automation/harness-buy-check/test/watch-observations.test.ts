import type { ObservedTask } from '../src/task-aws';
import { WatchObservations } from '../src/watch-observations';
import type { ProbeSample } from '../src/watch';

const first: ObservedTask = {
  arn: 'first-task',
  revision: 'candidate',
  digest: 'good',
  ip: '10.0.0.1',
};

const replacement = { ...first, arn: 'replacement-task' };
const active = { taskDefinitionArn: 'candidate', digest: 'good', state: 'ACTIVE' } as const;

function sample(task: ObservedTask, at: number): ProbeSample {
  return {
    taskArn: task.arn,
    taskDefinitionArn: task.revision,
    digest: task.digest,
    at,
    ready: true,
    recommendations: true,
  };
}

test('reassigned task IP cannot confirm probes against a departed candidate', () => {
  const watch = new WatchObservations('baseline', 'good', 'good', 300_000, 0);

  watch.observe(active, [first], 0);

  for (let at = 0; at <= 60_000; at += 1000) {
    watch.recordProbes([first], [sample(first, at)], at);

    if (at % 10_000 === 0 && at < 60_000) {
      watch.observe(active, [first], at);
    }
  }

  // The final samples needed for coverage used the old IP after the last identity check.
  watch.observe(active, [replacement], 60_100);

  for (let at = 61_000; at <= 125_000; at += 1000) {
    watch.recordProbes([replacement], [sample(replacement, at)], at);

    if (at % 5000 === 0) {
      watch.observe(active, [replacement], at);
    }
  }

  expect(watch.report(125_000).verdict).toBe('PENDING');
  expect(watch.observe({ ...active, state: 'COMPLETED' }, [replacement], 125_000)).toBeUndefined();

  for (let at = 150_000; at <= 300_000; at += 25_000) {
    const result = watch.observe({ ...active, state: 'COMPLETED' }, [replacement], at);

    expect(result?.exitCode).toBe(at === 300_000 ? 1 : undefined);
  }
});

test('a delayed discovery cannot keep readiness or the heartbeat clock fresh', () => {
  const watch = new WatchObservations('baseline', 'good', 'good', 300_000, 0);

  watch.observe(active, [first], 0);
  watch.recordProbes([first], [sample(first, 29_000)], 29_000);

  expect(watch.report(29_000).heartbeatAt).toBe(0);
  expect(() => watch.probeTargets(30_001)).toThrow('watcher task discovery became stale');
  expect(() => watch.report(30_001)).toThrow('watcher task discovery became stale');

  expect(() => watch.observe(active, [first], 30_001)).toThrow(
    'watcher task discovery became stale',
  );
});

test('a fast successful rollout keeps collecting its required minute of coverage', () => {
  const watch = new WatchObservations('baseline', 'good', 'good', 300_000, 0);
  const completed = { ...active, state: 'COMPLETED' } as const;

  expect(watch.observe(completed, [first], 0)).toBeUndefined();

  for (let at = 0; at <= 60_000; at += 1000) {
    watch.recordProbes([first], [sample(first, at)], at);

    if (at % 5000 === 0) {
      const result = watch.observe(completed, [first], at);

      expect(result?.exitCode).toBe(at === 60_000 ? 0 : undefined);
    }
  }
});

test.each(['FAILED', 'REVERTED'] as const)(
  'a %s deployment ends monitoring even when its candidate was never observed',
  (state) => {
    const watch = new WatchObservations('baseline', 'good', 'good', 300_000, 0);

    expect(
      watch.observe({ state, taskDefinitionArn: 'baseline', digest: 'good' }, [], 0)?.exitCode,
    ).toBe(1);

    expect(watch.report(0).verdict).toBe('PENDING');
  },
);

test.each([true, false])(
  'incomplete coverage cannot attest to bad traffic (probe passed = %s)',
  (ready) => {
    const watch = new WatchObservations('baseline', 'good', 'good', 300_000, 0);

    watch.observe(active, [first], 0);
    watch.recordProbes([first], [{ ...sample(first, 0), ready }], 0);

    for (let at = 25_000; at <= 300_000; at += 25_000) {
      watch.observe(active, [first], at);
      watch.recordProbes([first], [sample(first, at)], at);
    }

    expect(watch.report(300_000)).toMatchObject({ health: 'FAIL', verdict: 'PENDING' });
    expect(watch.observe({ ...active, state: 'COMPLETED' }, [first], 300_000)?.exitCode).toBe(1);
  },
);
