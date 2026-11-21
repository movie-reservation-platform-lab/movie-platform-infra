/** Runs ECS discovery, task HTTP probes and watcher heartbeat publication on independent schedules. */
import { MINUTE_MS, SANDBOX_LIMITS } from '@movie-platform/experiment-sandbox';
import type { CaseId } from './run-case';
import type { RuntimeConfig } from './runtime-config';
import type { RuntimePorts, TaskResult } from './runtime-types';
import { createTaskAws, type ObservedTask, type TaskAws } from './task-aws';
import { TrialCheckError } from './trial-check-error';
import { assertAllAlarmsOk, type ProbeSample } from './watch';
import { WatchObservations } from './watch-observations';

/**
 * Samples each discovered candidate task until ECS finishes the deployment or the trial expires.
 * Each loop permits one operation in flight. All loops drain before the final publication.
 */
export async function runWatchTask(
  config: RuntimeConfig,
  caseId: CaseId,
  ports: RuntimePorts,
): Promise<TaskResult> {
  const aws = createTaskAws(config, caseId, ports);
  const initial = await aws.observeWithTasks();
  const baseline = initial.observation;

  if (baseline.state !== 'COMPLETED' || baseline.digest !== config.goodImage.split('@')[1]) {
    throw new TrialCheckError('watcher requires observed healthy starting revision');
  }

  const now = ports.now();
  const deadline = now + SANDBOX_LIMITS.maxRunMinutes * MINUTE_MS;
  const candidateImage = caseId === 'bad' ? config.badImage : config.goodImage;

  const observations = new WatchObservations(
    baseline.taskDefinitionArn,
    baseline.digest,
    candidateImage.split('@')[1],
    now + STARTUP_TIMEOUT_MS,
    now,
  );

  observations.observe(baseline, initial.tasks, now);

  async function sample(): Promise<void> {
    const targets = observations.probeTargets(ports.now());
    const probes = await probeRunningTasks(targets, ports);

    observations.recordProbes(targets, probes, ports.now());
  }

  async function publish(): Promise<void> {
    const report = observations.report(ports.now());

    await aws.publish(report.ready, report.verdict, report.health, report.heartbeatAt);
  }

  // Seed the metric before checking alarms; the first report cannot grant readiness.
  await sample();
  await publish();
  observations.setAlarmReadiness(await alarmsAreOk(aws));

  let stopped = false;
  let terminal: TaskResult | undefined;

  async function discover(): Promise<void> {
    const snapshot = await aws.observeWithTasks(baseline.taskDefinitionArn);

    terminal = observations.observe(snapshot.observation, snapshot.tasks, ports.now());

    if (terminal) {
      stopped = true;
    } else if (observations.watchingBaseline) {
      observations.setAlarmReadiness(await alarmsAreOk(aws));
    }
  }

  async function repeat(step: () => Promise<void>, intervalMs: number): Promise<void> {
    try {
      while (!stopped && ports.now() < deadline) {
        const startedAt = ports.now();

        await step();

        if (!stopped) {
          await ports.sleep(Math.max(0, intervalMs - (ports.now() - startedAt)));
        }
      }
    } finally {
      stopped = true;
    }
  }

  await awaitAll([
    repeat(discover, DISCOVERY_INTERVAL_MS),
    repeat(sample, PROBE_INTERVAL_MS),
    repeat(publish, HEARTBEAT_INTERVAL_MS),
  ]);

  if (!terminal) {
    await aws.publish(false, 'PENDING', 'FAIL');

    return { exitCode: 1, reason: 'watcher timed out' };
  }

  const report = observations.report(ports.now());

  await aws.publish(
    report.ready,
    report.verdict,
    terminal.exitCode === 0 ? 'OK' : 'FAIL',
    report.heartbeatAt,
  );

  return terminal;
}

async function alarmsAreOk(aws: Pick<TaskAws, 'alarms'>): Promise<boolean> {
  try {
    assertAllAlarmsOk(await aws.alarms());

    return true;
  } catch {
    return false;
  }
}

/** Probes both endpoints of each selected task concurrently and attributes every result. */
async function probeRunningTasks(
  tasks: readonly ObservedTask[],
  ports: RuntimePorts,
): Promise<ProbeSample[]> {
  return awaitAll(
    tasks.map(async (task) => {
      const [isReady, recommendations] = await awaitAll([
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

/** Drains every operation before propagating a failure to the enclosing watcher. */
async function awaitAll<T>(operations: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(operations);

  return results.map((result) => {
    if (result.status === 'rejected') {
      throw result.reason;
    }

    return result.value;
  });
}

const STARTUP_TIMEOUT_MS = 300_000;
const DISCOVERY_INTERVAL_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 5000;
const PROBE_INTERVAL_MS = 1000;
