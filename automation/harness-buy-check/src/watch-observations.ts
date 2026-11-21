import { SANDBOX_LIMITS } from '@movie-platform/experiment-sandbox';
import type { ReleaseObservation } from './release';
import type { TaskResult } from './runtime-types';
import type { ObservedTask } from './task-aws';
import { TrialCheckError } from './trial-check-error';
import { candidateProbeEvidence, type ProbeSample, type Verdict } from './watch';

type Health = 'OK' | 'FAIL';

interface WatchReport {
  ready: boolean;
  verdict: Verdict;
  health: Health;
  heartbeatAt: number;
}

interface PendingProbe {
  task: ObservedTask;
  sample: ProbeSample;
}

/** Tracks task identity across successive ECS reads and the samples attributable to each task. */
export class WatchObservations {
  private targets: ObservedTask[] = [];
  private observedAt: number;
  private lastProbeAt: number;
  private candidateRevision?: string;
  private candidateStartedAt = 0;
  private readonly candidateTasks = new Set<string>();
  private pending: PendingProbe[] = [];
  private readonly samples: ProbeSample[] = [];
  private evidence: ReturnType<typeof candidateProbeEvidence> = 'PENDING';
  private baselineHealthy = false;
  private alarmsOk = false;

  constructor(
    private readonly baselineRevision: string,
    private readonly baselineDigest: string,
    private readonly candidateDigest: string,
    private readonly startupDeadline: number,
    now: number,
  ) {
    this.observedAt = now;
    this.lastProbeAt = now;
  }

  get watchingBaseline(): boolean {
    return this.candidateRevision === undefined;
  }

  setAlarmReadiness(ok: boolean): void {
    this.alarmsOk = ok;
  }

  /** Sampling and publication may proceed during a discovery only while its last result is fresh. */
  probeTargets(now: number): readonly ObservedTask[] {
    this.requireFreshDiscovery(now);

    return this.targets;
  }

  /** Captures the exact identities used to issue these probes, including their private addresses. */
  recordProbes(targets: readonly ObservedTask[], probes: ProbeSample[], now: number): void {
    this.requireFreshDiscovery(now);
    this.lastProbeAt = now;

    if (this.watchingBaseline) {
      this.baselineHealthy =
        targets.length === 2 &&
        targets.every((task) => this.targets.some((current) => sameTask(current, task))) &&
        probes.every((probe) => probe.ready && probe.recommendations);

      return;
    }

    for (const [index, task] of targets.entries()) {
      if (task.revision === this.candidateRevision && this.targets.some((t) => sameTask(t, task))) {
        this.pending.push({ task, sample: probes[index] });
      }
    }
  }

  /** Commits probes only after ECS has independently reconfirmed the same task on the same IP. */
  observe(
    observation: ReleaseObservation,
    tasks: readonly ObservedTask[],
    now: number,
  ): TaskResult | undefined {
    this.requireFreshDiscovery(now);
    this.observedAt = now;

    if (observation.state === 'FAILED') {
      return { exitCode: 1, reason: 'ECS deployment failed' };
    }

    if (observation.state === 'REVERTED' && this.watchingBaseline) {
      return { exitCode: 1, reason: 'ECS returned to original revision' };
    }

    if (
      this.watchingBaseline &&
      observation.state !== 'PENDING' &&
      observation.taskDefinitionArn !== this.baselineRevision
    ) {
      this.candidateRevision = observation.taskDefinitionArn;
      this.candidateStartedAt = now;
    }

    if (!this.candidateRevision) {
      const next = tasks.filter((task) => task.revision === this.baselineRevision);

      if (next.some((task) => task.digest !== this.baselineDigest)) {
        throw new TrialCheckError('watcher requires observed healthy starting revision');
      }

      if (next.length !== 2 || !this.targets.every((old) => next.some((t) => sameTask(t, old)))) {
        this.baselineHealthy = false;
      }

      this.targets = next;

      return;
    }

    if (
      observation.taskDefinitionArn !== this.candidateRevision &&
      observation.taskDefinitionArn !== this.baselineRevision
    ) {
      throw new TrialCheckError('watcher observed an unexpected task definition');
    }

    this.targets = tasks.filter((task) => task.revision === this.candidateRevision);

    for (const task of this.targets) {
      if (task.digest !== this.candidateDigest) {
        throw new TrialCheckError('observed candidate digest differs from approved artifact');
      }

      this.candidateTasks.add(task.arn);
    }

    for (const { task, sample } of this.pending) {
      if (this.targets.some((current) => sameTask(current, task))) {
        this.samples.push(sample);
      }
    }

    this.pending = [];

    if (this.evidence === 'PENDING' || this.evidence === 'PASS') {
      this.evidence = candidateProbeEvidence({
        candidateTaskDefinitionArn: this.candidateRevision,
        candidateDigest: this.candidateDigest,
        candidateTasks: [...this.candidateTasks],
        startedAt: this.candidateStartedAt,
        now,
        samples: this.samples,
      });
    }

    if (observation.state === 'REVERTED') {
      return { exitCode: 1, reason: 'ECS returned to original revision' };
    }

    if (observation.state === 'COMPLETED' && this.evidence !== 'PENDING') {
      const passed =
        this.evidence === 'PASS' && observation.taskDefinitionArn === this.candidateRevision;

      return {
        exitCode: passed ? 0 : 1,
        reason: passed
          ? 'candidate probes and completed revision observed'
          : 'candidate completed without passing attributed probe verdict',
      };
    }

    return undefined;
  }

  report(now: number): WatchReport {
    this.requireFreshDiscovery(now);

    const ready = this.baselineHealthy && this.alarmsOk;

    if (this.watchingBaseline && !ready && now >= this.startupDeadline) {
      throw new TrialCheckError('watcher startup/alarm readiness timed out');
    }

    const healthy = this.watchingBaseline
      ? this.baselineHealthy
      : this.evidence === 'PENDING' || this.evidence === 'PASS';

    return {
      ready,
      verdict: this.evidence === 'INSUFFICIENT_COVERAGE' ? 'PENDING' : this.evidence,
      health: healthy ? 'OK' : 'FAIL',
      heartbeatAt: Math.min(this.observedAt, this.lastProbeAt),
    };
  }

  private requireFreshDiscovery(now: number): void {
    if (now - this.observedAt > SANDBOX_LIMITS.watchHeartbeatMaxAgeSeconds * 1000) {
      throw new TrialCheckError('watcher task discovery became stale');
    }
  }
}

function sameTask(first: ObservedTask, second: ObservedTask): boolean {
  return (
    first.arn === second.arn &&
    first.revision === second.revision &&
    first.digest === second.digest &&
    first.ip === second.ip
  );
}
