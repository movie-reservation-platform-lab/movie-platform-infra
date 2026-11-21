import { runTask } from '../src/task-runtime';
import { rolloutConfig, timedEcsRollout } from './fixtures/timed-ecs-rollout';

beforeEach(() => {
  jest.useFakeTimers({ now: Date.UTC(2026, 0, 1) });
});

afterEach(() => {
  jest.useRealTimers();
});

test.each(['good', 'bad'] as const)(
  '%s rollout observes real probe and release decisions with delayed AWS calls',
  async (caseId) => {
    const trial = timedEcsRollout(caseId);
    const watch = runTask('watch', caseId, rolloutConfig, trial.ports);
    // Collect both results even when the old release implementation rejects early.
    const watchResult = Promise.allSettled([watch]);

    for (let seconds = 0; !trial.ready() && seconds < 300; seconds += 5) {
      await jest.advanceTimersByTimeAsync(5000);
    }

    expect(trial.ready()).toBe(true);

    const release = runTask('release', caseId, rolloutConfig, trial.ports);
    const releaseResult = Promise.allSettled([release]);

    await jest.advanceTimersByTimeAsync(47 * 60_000);
    const [watchOutcome] = await watchResult;
    const [releaseOutcome] = await releaseResult;

    if (watchOutcome.status === 'rejected') {
      throw watchOutcome.reason;
    }

    if (releaseOutcome.status === 'rejected') {
      throw releaseOutcome.reason;
    }

    expect([...trial.probes.keys()].sort()).toEqual(['10.0.0.3', '10.0.0.4']);

    const updatedAt = trial.updatedAt()!;
    const coverageEnd = updatedAt + 300_000;
    const failedAt = trial.firstFailedVerdictAt();

    expect(trial.heartbeatAgesAtRefresh.length).toBeGreaterThan(1);
    expect(Math.max(...trial.heartbeatAgesAtRefresh)).toBeLessThanOrEqual(30_000);

    // Prove coverage before the first FAIL. A timeout-driven rollback cannot pass this test.
    for (const samples of trial.probes.values()) {
      const evidence = samples.filter(
        ({ at }) => at <= Math.min(failedAt ?? Infinity, coverageEnd),
      );

      const times = [...new Set(evidence.map(({ at }) => at))];

      expect(times.length).toBeGreaterThanOrEqual(60);
      expect(times[times.length - 1] - times[0]).toBeGreaterThanOrEqual(60_000);
      expect(evidence.some(({ ok }) => !ok)).toBe(caseId === 'bad');
    }

    if (caseId === 'good') {
      expect(failedAt).toBeUndefined();

      expect(releaseOutcome.value).toMatchObject({
        exitCode: 0,
        reverted: false,
        revision: 'recipe:2',
      });

      expect(watchOutcome.value.exitCode).toBe(0);
      expect(trial.state()).toBe('SUCCESSFUL');
    } else {
      expect(failedAt).toBeLessThan(coverageEnd);

      expect(releaseOutcome.value).toMatchObject({
        exitCode: 1,
        reverted: true,
        revision: 'recipe:2',
        originalTaskDefinitionArn: 'recipe:1',
        observedOriginalDigest: rolloutConfig.goodImage.split('@')[1],
      });

      expect(watchOutcome.value.exitCode).toBe(1);
      expect(trial.state()).toBe('ROLLBACK_SUCCESSFUL');
    }
  },
);
