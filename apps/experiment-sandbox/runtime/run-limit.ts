/**
 * The run limit for trial steps: which running trial tasks have run too long.
 *
 * ECS has no built-in task timeout, and a hung trial step would otherwise keep running
 * until lease expiry. While running it counts as active, so "one case at a time" blocks
 * every other case. The expiry schedule uses this check to stop such steps; the launcher
 * then sees them as stopped and marks the step `FAILED`.
 *
 * This file holds only the decision, with no AWS calls; `cleanup-handler.ts` describes
 * the tasks and stops the ones returned here.
 */

import { MINUTE_MS, SANDBOX_LIMITS } from '@movie-platform/experiment-sandbox';

/** A step may run this long before the schedule stops it. */
const RUN_LIMIT_MS =
  (SANDBOX_LIMITS.maxRunMinutes + SANDBOX_LIMITS.runLimitGraceMinutes) * MINUTE_MS;

/** ECS prefixes the group of a standalone task with this; service tasks use `service:`. */
const STANDALONE_TASK_GROUP_PREFIX = 'family:';

/** A task in the workload cluster, as ECS describes it. */
export interface ClusterTask {
  readonly taskArn: string;
  /** `family:<task definition family>` for tasks started with RunTask. */
  readonly group?: string;
  readonly startedAt?: Date;
  /** Used when the task never started, for example when it is stuck pulling its image. */
  readonly createdAt?: Date;
}

/**
 * ARNs of trial tasks that have run longer than the run limit plus its grace period.
 * Service tasks (recommendation, delegate) and tasks of other families are never returned.
 *
 * @param trialFamilies - the nine trial step task definition families
 * @param now - epoch milliseconds
 */
export function overdueTrialTaskArns(
  tasks: readonly ClusterTask[],
  trialFamilies: ReadonlySet<string>,
  now: number,
): string[] {
  return tasks
    .filter((task) => isTrialTask(task, trialFamilies))
    .filter((task) => {
      const runningSince = task.startedAt ?? task.createdAt;

      return runningSince !== undefined && now - runningSince.getTime() > RUN_LIMIT_MS;
    })
    .map((task) => task.taskArn);
}

function isTrialTask(task: ClusterTask, trialFamilies: ReadonlySet<string>): boolean {
  if (!task.group?.startsWith(STANDALONE_TASK_GROUP_PREFIX)) {
    return false;
  }

  return trialFamilies.has(task.group.slice(STANDALONE_TASK_GROUP_PREFIX.length));
}
