/**
 * Decides candidate probe coverage and watcher readiness from supplied observations.
 * These decisions perform no I/O; callers collect task identities, samples and alarms.
 */

/**
 * Evaluates probe evidence attributed to the candidate's tasks, revision and image digest.
 * Each distinct task needs at least 60 distinct sample timestamps spanning at least one
 * minute, collected within the first five minutes. Matching later samples still count
 * toward detecting failures during continued monitoring.
 *
 * @param input - candidate identities, observation window and collected probe samples;
 *   all timestamps use milliseconds on the same clock
 * @returns PASS when every task has coverage and no matching sample fails; FAIL when
 *   coverage is complete with a failed probe, or incomplete after five minutes;
 *   otherwise PENDING, including failures observed before coverage is complete
 * @throws Error when now is non-finite or precedes the observation start
 */
export function candidateVerdict(input: CoverageInput): Verdict {
  if (input.now < input.startedAt || !Number.isFinite(input.now)) {
    throw new Error('invalid observation clock');
  }

  let failed = false;
  let covered = input.candidateTasks.length > 0;

  for (const taskArn of new Set(input.candidateTasks)) {
    const taskSamples = selectCandidateTaskSamples(input, taskArn);

    if (!hasRequiredCoverage(taskSamples, input.startedAt)) {
      covered = false;
    }

    if (taskSamples.some(isFailedProbe)) {
      failed = true;
    }
  }

  if (covered) {
    return failed ? 'FAIL' : 'PASS';
  }

  return input.now - input.startedAt >= COVERAGE_WINDOW_MS ? 'FAIL' : 'PENDING';
}

/**
 * Requires a ready watcher with a recent heartbeat and healthy reported alarms.
 *
 * @param watch - watcher readiness, heartbeat and reported alarm states
 * @param now - current time in milliseconds on the same clock as heartbeatAt
 * @throws Error when readiness is false, the heartbeat is non-finite, in the future
 *   or older than 30 seconds, or the reported alarms are empty or not all OK
 */
export function assertWatchReady(watch: WatchReadiness, now: number): void {
  if (
    !watch.ready ||
    !Number.isFinite(watch.heartbeatAt) ||
    now < watch.heartbeatAt ||
    now - watch.heartbeatAt > 30000
  ) {
    throw new Error('watcher is missing or stale');
  }

  assertAllAlarmsOk(watch.alarmStates);
}

/**
 * Requires a nonempty collection of alarm observations whose states are all OK.
 *
 * @param states - alarm identifiers mapped to their observed state names
 * @throws Error when no alarms are supplied or any supplied alarm is not OK
 */
export function assertAllAlarmsOk(states: Readonly<Record<string, string>>): void {
  if (!Object.keys(states).length || Object.values(states).some((state) => state !== 'OK')) {
    throw new Error('every watched alarm must be OK');
  }
}

/** Selects one candidate task's observations within the current observation period. */
function selectCandidateTaskSamples(input: CoverageInput, taskArn: string): ProbeSample[] {
  return input.samples.filter(
    (sample) =>
      sample.taskArn === taskArn &&
      sample.taskDefinitionArn === input.candidateTaskDefinitionArn &&
      sample.digest === input.candidateDigest &&
      sample.at >= input.startedAt &&
      sample.at <= input.now,
  );
}

/** Checks sample count and time span within the initial coverage window; times are milliseconds. */
function hasRequiredCoverage(samples: readonly ProbeSample[], startedAt: number): boolean {
  // Later observations still detect failures, but cannot establish initial coverage.
  const coverageSamples = samples.filter((sample) => sample.at <= startedAt + COVERAGE_WINDOW_MS);

  const times = [...new Set(coverageSamples.map((sample) => sample.at))].sort(
    (earlier, later) => earlier - later,
  );

  return (
    times.length >= MIN_SAMPLE_COUNT &&
    times[times.length - 1] - times[0] >= MIN_COVERAGE_DURATION_MS
  );
}

/** Whether either endpoint probe failed in this observation. */
function isFailedProbe(sample: ProbeSample): boolean {
  return !sample.ready || !sample.recommendations;
}

/** Maximum time after observation starts in which initial coverage can be established. */
const COVERAGE_WINDOW_MS = 300_000;

/** Distinct observation timestamps required for each candidate task. */
const MIN_SAMPLE_COUNT = 60;

/** Minimum span between the first and last coverage observations for each task. */
const MIN_COVERAGE_DURATION_MS = 60_000;

/** Candidate evidence decision; PENDING means sufficient coverage is not established yet. */
export type Verdict = 'PENDING' | 'PASS' | 'FAIL';

/** Observations used to decide whether a candidate has sufficient healthy probe coverage. */
export interface CoverageInput {
  candidateTaskDefinitionArn: string;
  candidateDigest: string;
  /** Tasks that must each meet coverage requirements; an empty collection cannot pass. */
  candidateTasks: readonly string[];
  /** Observation start in milliseconds; establishes the five-minute coverage window. */
  startedAt: number;
  /** Decision time in milliseconds on the same clock as the samples and observation start. */
  now: number;
  samples: readonly ProbeSample[];
}

/**
 * One recorded set of readiness and recommendations probe results for one running task
 * at one moment. A sample is one recorded probe result from one running task at one moment.
 */
export interface ProbeSample {
  taskArn: string;
  taskDefinitionArn: string;
  digest: string;
  /** Sample time in milliseconds on the observation clock. */
  at: number;
  /** Whether the readiness probe passed. */
  ready: boolean;
  /** Whether the recommendations probe passed. */
  recommendations: boolean;
}

/** Watcher report required before a release may update the service. */
export interface WatchReadiness {
  /** The watcher reports that it has established its monitoring baseline. */
  ready: boolean;
  /** Latest heartbeat time in milliseconds on the caller's clock. */
  heartbeatAt: number;
  /** Alarm identifiers mapped to the state names last reported by the watcher. */
  alarmStates: Readonly<Record<string, string>>;
}
