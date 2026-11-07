/**
 * Unit tests for the trial step run limit: which running tasks the expiry schedule stops.
 */

import { overdueTrialTaskArns, type ClusterTask } from '../runtime/run-limit';

const NOW = Date.parse('2030-01-01T02:00:00Z');
const TRIAL_FAMILIES = new Set(['exp-test-good-watch', 'exp-test-good-release']);

/** A task that started `minutesAgo` before {@link NOW}. */
function taskStarted(minutesAgo: number, group: string): ClusterTask {
  return {
    taskArn: `task-${group}-${minutesAgo}`,
    group,
    startedAt: new Date(NOW - minutesAgo * 60_000),
  };
}

describe('overdueTrialTaskArns', () => {
  it('stops a trial step running longer than 45 minutes plus the 5-minute grace', () => {
    const hung = taskStarted(51, 'family:exp-test-good-watch');

    expect(overdueTrialTaskArns([hung], TRIAL_FAMILIES, NOW)).toEqual([hung.taskArn]);
  });

  it('leaves a trial step that is still inside its grace period', () => {
    const finishing = taskStarted(49, 'family:exp-test-good-release');

    expect(overdueTrialTaskArns([finishing], TRIAL_FAMILIES, NOW)).toEqual([]);
  });

  it('never stops service tasks, however long they run', () => {
    const service = taskStarted(180, 'service:exp-test-recommendation');

    expect(overdueTrialTaskArns([service], TRIAL_FAMILIES, NOW)).toEqual([]);
  });

  it('never stops standalone tasks of other families', () => {
    const other = taskStarted(180, 'family:exp-test-delegate');

    expect(overdueTrialTaskArns([other], TRIAL_FAMILIES, NOW)).toEqual([]);
  });

  it('measures a task that never started from its creation time', () => {
    const stuckPulling: ClusterTask = {
      taskArn: 'task-stuck',
      group: 'family:exp-test-good-watch',
      createdAt: new Date(NOW - 60 * 60_000),
    };

    expect(overdueTrialTaskArns([stuckPulling], TRIAL_FAMILIES, NOW)).toEqual(['task-stuck']);
  });
});
