/** Runs baseline readiness checks and candidate probes, publishing trial evidence each pass. */
import { MINUTE_MS, SANDBOX_LIMITS } from '@movie-platform/experiment-sandbox';
import type { CaseId } from './run-case';
import type { RuntimeConfig } from './runtime-config';
import type { RuntimePorts, TaskResult } from './runtime-types';
import { createTaskAws, type TaskAws, type ObservedTask } from './task-aws';
import type { ReleaseObservation } from './release';
import { assertAllAlarmsOk, candidateVerdict, type ProbeSample, type Verdict } from './watch';

/**
 * Probes the healthy baseline until ready, then tracks the first candidate revision.
 * Publishes health and candidate coverage until completion, reversion or timeout.
 *
 * @param config - validated ECS targets, approved images and observation destinations
 * @param caseId - scenario determining the approved candidate image
 * @param ports - AWS transport, HTTP probes, delay and millisecond clock
 * @returns zero only when a completed candidate has a passing attributed probe verdict
 * @throws Error when the baseline, candidate identity, startup deadline or AWS calls fail
 */
export async function runWatchTask(
  config: RuntimeConfig,
  caseId: CaseId,
  ports: RuntimePorts,
): Promise<TaskResult> {
  const aws = createTaskAws(config, caseId, ports);
  const initial = await aws.observe();

  if (initial.state !== 'COMPLETED' || initial.digest !== config.goodImage.split('@')[1]) {
    throw new Error('watcher requires observed healthy starting revision');
  }

  const deadline = ports.now() + SANDBOX_LIMITS.maxRunMinutes * MINUTE_MS;
  const startupDeadline = ports.now() + STARTUP_TIMEOUT_MS;
  let ready = false;
  let candidateRevision: string | undefined;
  let candidateStartedAt = 0;
  let verdict: Verdict = 'PENDING';
  const samples: ProbeSample[] = [];
  const candidateTasks = new Set<string>();

  while (ports.now() < deadline) {
    const observed = await aws.observe(initial.taskDefinitionArn);
    const tasks = await aws.tasks();

    if (!candidateRevision && observed.taskDefinitionArn !== initial.taskDefinitionArn) {
      candidateRevision = observed.taskDefinitionArn;
      candidateStartedAt = ports.now();
    }

    const approvedDigest = (caseId === 'bad' ? config.badImage : config.goodImage).split('@')[1];

    const selected = tasks.filter(
      (task) => task.revision === (candidateRevision ?? initial.taskDefinitionArn),
    );

    const probes = await probeRunningTasks(selected, ports);

    if (!candidateRevision) {
      const baselineHealthy =
        selected.length === 2 && probes.every((probe) => probe.ready && probe.recommendations);

      ready = await refreshStartupReadiness(aws, ready, baselineHealthy);

      if (!ready && ports.now() >= startupDeadline) {
        throw new Error('watcher startup/alarm readiness timed out');
      }
    } else {
      for (const task of selected) {
        candidateTasks.add(task.arn);

        if (task.digest !== approvedDigest) {
          throw new Error('observed candidate digest differs from approved artifact');
        }
      }

      samples.push(...probes);

      verdict = candidateVerdict({
        candidateTaskDefinitionArn: candidateRevision,
        candidateDigest: approvedDigest,
        candidateTasks: [...candidateTasks],
        startedAt: candidateStartedAt,
        now: ports.now(),
        samples,
      });

      const result = await finishCandidateObservation(aws, observed, ready, verdict);

      if (result) {
        return result;
      }
    }

    await aws.publish(ready, verdict, verdict === 'FAIL' ? 'FAIL' : 'OK');
    await ports.sleep(PROBE_INTERVAL_MS);
  }

  await aws.publish(false, 'FAIL', 'FAIL');

  return { exitCode: 1, reason: 'watcher timed out' };
}

/** Refreshes startup health before alarm reads; only successful alarm checks grant readiness. */
async function refreshStartupReadiness(
  aws: Pick<ReturnType<typeof createTaskAws>, 'alarms' | 'publish'>,
  previousReady: boolean,
  baselineHealthy: boolean,
): Promise<boolean> {
  // Refresh metrics before waiting for alarms, retaining readiness already earned.
  // A newly failed baseline probe revokes it immediately.
  await aws.publish(previousReady && baselineHealthy, 'PENDING', baselineHealthy ? 'OK' : 'FAIL');

  try {
    assertAllAlarmsOk(await aws.alarms());

    return baselineHealthy;
  } catch {
    return false;
  }
}

/** Probes both endpoints of each selected task concurrently and attributes every result. */
async function probeRunningTasks(
  tasks: readonly ObservedTask[],
  ports: RuntimePorts,
): Promise<ProbeSample[]> {
  return Promise.all(
    tasks.map(async (task) => {
      const [isReady, recommendations] = await Promise.all([
        ports.probe(task.ip, '/ready'),
        ports.probe(task.ip, '/recommendations'),
      ]);

      return {
        taskArn: task.arn,
        taskDefinitionArn: task.revision,
        digest: task.digest,
        at: ports.now(),
        ready: isReady,
        recommendations,
      };
    }),
  );
}

/** Publishes the terminal candidate observation, or returns undefined to keep monitoring. */
async function finishCandidateObservation(
  aws: Pick<TaskAws, 'publish'>,
  observed: ReleaseObservation,
  ready: boolean,
  verdict: Verdict,
): Promise<TaskResult | undefined> {
  if (observed.state === 'COMPLETED') {
    await aws.publish(ready, verdict, verdict === 'FAIL' ? 'FAIL' : 'OK');

    return {
      exitCode: verdict === 'PASS' ? 0 : 1,
      reason:
        verdict === 'PASS'
          ? 'candidate probes and completed revision observed'
          : 'candidate completed without passing attributed probe verdict',
    };
  }

  if (observed.state === 'REVERTED') {
    await aws.publish(ready, verdict, 'FAIL');

    return { exitCode: 1, reason: 'ECS returned to original revision' };
  }

  return undefined;
}

/** Maximum startup wait for healthy baseline probes and observed OK alarms. */
const STARTUP_TIMEOUT_MS = 300_000;

/** Delay between watcher observation passes. */
const PROBE_INTERVAL_MS = 1000;
