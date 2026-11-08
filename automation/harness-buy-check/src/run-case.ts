import { MINUTE_MS, SANDBOX_LIMITS } from '@movie-platform/experiment-sandbox';

export type CaseId = 'good' | 'blocked' | 'bad';

export type StepId = 'gate' | 'watch' | 'release';

export interface LaunchRequest {
  experimentId: string;
  caseId: CaseId;
  stepId: StepId;
}

export interface LaunchStatus extends LaunchRequest {
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'STOPPED';
  taskArn?: string;
  timedOut?: true;
}

export interface Scheduler {
  invoke(request: LaunchRequest): Promise<LaunchStatus>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface CaseResult {
  mode: 'live' | 'offline';
  caseId: CaseId;
  outcome: 'PASS' | 'FAIL';
  releaseLaunched: boolean;
  reason: string;
}

/** Per-outcome fields; the result builder supplies the case identity and execution mode. */
type CaseResultDetails = Pick<CaseResult, 'outcome' | 'releaseLaunched' | 'reason'>;

/**
 * Polls the launcher with the same step request until it reports a terminal status,
 * a running watcher, or the shared deadline expires. Preserves any observed task ARN
 * when later responses omit it.
 *
 * @param request - fixed experiment, case and step identity sent on every poll
 * @param scheduler - launcher invocation, polling delay and clock
 * @param deadline - absolute cutoff in milliseconds, using the scheduler's clock
 * @returns the observed status, or FAILED with timedOut set when the deadline expires;
 *   a returned status still needs the caller's step-specific success check
 * @throws Error when a launcher response mismatches the request or has an unknown status;
 *   scheduler failures propagate to the caller
 */
export async function waitStep(
  request: LaunchRequest,
  scheduler: Scheduler,
  deadline: number,
): Promise<LaunchStatus> {
  let observedTaskArn: string | undefined;

  while (scheduler.now() < deadline) {
    const status = await scheduler.invoke(request);

    if (
      status.experimentId !== request.experimentId ||
      status.caseId !== request.caseId ||
      status.stepId !== request.stepId ||
      !['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'STOPPED'].includes(status.status)
    ) {
      throw new Error('launcher response does not match fixed request');
    }

    observedTaskArn = status.taskArn ?? observedTaskArn;

    if (
      status.status === 'FAILED' ||
      status.status === 'STOPPED' ||
      status.status === 'SUCCEEDED' ||
      (request.stepId === 'watch' && status.status === 'RUNNING')
    ) {
      return { ...status, taskArn: observedTaskArn };
    }

    await scheduler.sleep(Math.min(5000, deadline - scheduler.now()));
  }

  return { ...request, status: 'FAILED', taskArn: observedTaskArn, timedOut: true };
}

/**
 * Runs one trial case through gate, watch and release, sharing one deadline across
 * all steps. The gate must succeed and the watcher must be running before release.
 *
 * @param caseId - registered scenario: healthy release, blocked release or bad canary
 * @param experimentId - sandbox experiment identity sent with every launch request
 * @param scheduler - launcher invocation, polling delay and clock used to observe steps
 * @returns a live result; only the good case can pass, with an observed release task ARN
 * @throws Error when the scheduler fails or a launcher response mismatches the request;
 *   step failure, timeout and unexpected scenario success return a FAIL result instead
 */
export async function runCase(
  caseId: CaseId,
  experimentId: string,
  scheduler: Scheduler,
): Promise<CaseResult> {
  const deadline = scheduler.now() + SANDBOX_LIMITS.maxRunMinutes * MINUTE_MS;

  const buildResult = (details: CaseResultDetails): CaseResult => ({
    mode: 'live',
    caseId,
    ...details,
  });

  const gate = await waitStep({ experimentId, caseId, stepId: 'gate' }, scheduler, deadline);

  if (gate.status !== 'SUCCEEDED') {
    return buildResult({
      outcome: 'FAIL',
      releaseLaunched: false,
      reason: `gate ${gate.timedOut ? 'timed out' : 'failed'}`,
    });
  }

  const watch = await waitStep({ experimentId, caseId, stepId: 'watch' }, scheduler, deadline);

  if (watch.status !== 'RUNNING') {
    return buildResult({
      outcome: 'FAIL',
      releaseLaunched: false,
      reason: `watch ${watch.timedOut ? 'timed out' : 'failed'}`,
    });
  }

  const release = await waitStep({ experimentId, caseId, stepId: 'release' }, scheduler, deadline);

  if (release.status !== 'SUCCEEDED') {
    return buildResult({
      outcome: 'FAIL',
      releaseLaunched: Boolean(release.taskArn),
      reason: `release ${release.timedOut ? 'timed out' : 'failed'}`,
    });
  }

  if (!release.taskArn) {
    return buildResult({
      outcome: 'FAIL',
      releaseLaunched: false,
      reason: 'release success lacks observed task identity',
    });
  }

  if (caseId !== 'good') {
    return buildResult({
      outcome: 'FAIL',
      releaseLaunched: true,
      reason: 'expected failing case unexpectedly succeeded',
    });
  }

  return buildResult({
    outcome: 'PASS',
    releaseLaunched: true,
    reason: 'trusted launcher observed successful release task',
  });
}
