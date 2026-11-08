import { MINUTE_MS, SANDBOX_LIMITS } from '@movie-platform/experiment-sandbox';
import { assertAllAlarmsOk, assertWatchReady, WatchReadiness, Verdict } from './watch';

export interface ReleaseObservation {
  state: 'ACTIVE' | 'COMPLETED' | 'REVERTED' | 'FAILED';
  taskDefinitionArn: string;
  digest: string;
}

export interface ReleasePort {
  now(): number;
  sleep(ms: number): Promise<void>;
  watch(): Promise<WatchReadiness>;
  alarms(): Promise<Readonly<Record<string, string>>>;
  register(): Promise<string>;
  update(taskDefinitionArn: string): Promise<void>;
  observe(): Promise<ReleaseObservation>;
  verdict(): Promise<Verdict>;
}

export interface ReleaseResult {
  outcome: 'PASS' | 'FAIL';
  reason: string;
  revision?: string;
  reverted: boolean;
}

/** Failure details; rollback defaults to unverified unless explicitly confirmed. */
type ReleaseFailureDetails = Pick<ReleaseResult, 'reason'> &
  Partial<Pick<ReleaseResult, 'reverted'>>;

/**
 * Registers and deploys a candidate after verifying the baseline, watcher and alarms,
 * then polls deployment and probe evidence until a result or the observation deadline.
 * A verified rollback remains a failed release, with reverted set to true.
 *
 * @param port - deployment operations, monitoring observations, polling delay and clock
 * @param candidateDigest - image digest the completed candidate must be observed running
 * @param original - steady deployment identity used to verify a return to the baseline
 * @returns PASS only when the completed candidate identity matches and probes pass;
 *   deployment failure, insufficient rollback evidence, heartbeat loss and timeout return FAIL
 * @throws Error when the baseline is not steady, readiness or alarm checks fail,
 *   or a port operation rejects
 */
export async function releaseCandidate(
  port: ReleasePort,
  candidateDigest: string,
  original: ReleaseObservation,
): Promise<ReleaseResult> {
  const revision = await deployCandidate(port, original);
  const attempt: ReleaseAttempt = { revision, candidateDigest, original };
  const history: ReleaseHistory = { sawActive: false, failedWhileActive: false };
  const deadline = port.now() + SANDBOX_LIMITS.maxRunMinutes * MINUTE_MS;

  while (port.now() < deadline) {
    const observation = await port.observe();
    const verdict = await port.verdict();

    if (observation.state === 'ACTIVE') {
      history.sawActive = true;

      if (verdict === 'FAIL') {
        history.failedWhileActive = true;
      }
    }

    const result = evaluateDeploymentObservation(observation, verdict, attempt, history);

    if (result) {
      return result;
    }

    if (await hasLostWatcherHeartbeat(port)) {
      return buildFailure(revision, { reason: 'watcher heartbeat lost' });
    }

    await port.sleep(Math.min(5000, deadline - port.now()));
  }

  return buildFailure(revision, { reason: 'deployment or probe verdict timed out' });
}

/** Validates the baseline and safeguards, registers a revision, then updates the service. */
async function deployCandidate(port: ReleasePort, original: ReleaseObservation): Promise<string> {
  if (original.state !== 'COMPLETED') {
    throw new Error('starting service is not steady');
  }

  await assertReleaseMonitoringReady(port);
  const revision = await port.register();

  // Registering is harmless to service state; recheck the watcher immediately before mutation.
  await assertReleaseMonitoringReady(port);
  await port.update(revision);

  return revision;
}

/** Rechecks both the watcher's readiness report and independently fetched alarm states. */
async function assertReleaseMonitoringReady(port: ReleasePort): Promise<void> {
  assertWatchReady(await port.watch(), port.now());
  assertAllAlarmsOk(await port.alarms());
}

/** Decides whether one observation ends the attempt; undefined means keep polling. */
function evaluateDeploymentObservation(
  observation: ReleaseObservation,
  verdict: Verdict,
  attempt: ReleaseAttempt,
  history: ReleaseHistory,
): ReleaseResult | undefined {
  const { revision, candidateDigest, original } = attempt;

  switch (observation.state) {
    case 'ACTIVE':
      return undefined;
    case 'REVERTED':
      if (
        history.failedWhileActive &&
        observation.taskDefinitionArn === original.taskDefinitionArn &&
        observation.digest === original.digest
      ) {
        return buildFailure(revision, {
          reason: 'candidate failed while active; ECS reverted original revision',
          reverted: true,
        });
      }

      if (history.sawActive) {
        return buildFailure(revision, {
          reason: 'revert lacks active failure or original revision evidence',
        });
      }

      // The old deployment may still be observed immediately after update.
      return undefined;
    case 'FAILED':
      return buildFailure(revision, { reason: 'ECS deployment failed' });
    case 'COMPLETED':
      if (history.failedWhileActive || verdict === 'FAIL') {
        return buildFailure(revision, {
          reason: 'candidate failure observed; completed release requires operator recovery',
        });
      }

      if (verdict === 'PASS') {
        if (observation.taskDefinitionArn !== revision || observation.digest !== candidateDigest) {
          return buildFailure(revision, { reason: 'running candidate identity mismatch' });
        }

        return {
          outcome: 'PASS',
          reason: 'completed candidate and attributed probes passed',
          revision,
          reverted: false,
        };
      }

      return undefined;
  }
}

/** Checks heartbeat freshness during polling without reapplying pre-release alarm gates. */
async function hasLostWatcherHeartbeat(port: ReleasePort): Promise<boolean> {
  const heartbeat = await port.watch();

  return (
    !Number.isFinite(heartbeat.heartbeatAt) ||
    port.now() < heartbeat.heartbeatAt ||
    port.now() - heartbeat.heartbeatAt > 30000
  );
}

/** Builds a failure tied to the registered revision; rollback is unverified by default. */
function buildFailure(
  revision: string,
  { reason, reverted = false }: ReleaseFailureDetails,
): ReleaseResult {
  return { outcome: 'FAIL', reason, revision, reverted };
}

/** Fixed candidate and baseline identities used throughout one deployment attempt. */
interface ReleaseAttempt {
  revision: string;
  candidateDigest: string;
  original: ReleaseObservation;
}

/** Evidence remembered across polls; an observed active failure cannot be cleared. */
interface ReleaseHistory {
  sawActive: boolean;
  failedWhileActive: boolean;
}
