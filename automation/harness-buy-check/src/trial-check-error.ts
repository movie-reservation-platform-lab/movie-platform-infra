/** Fixed diagnostic messages that may be written to protected task logs. */
type TrialCheckReason =
  | 'watcher task discovery became stale'
  | 'watcher observed an unexpected task definition'
  | 'watch verdict stale'
  | 'watcher is missing or stale'
  | 'every watched alarm must be OK'
  | 'watcher startup/alarm readiness timed out'
  | 'watcher requires observed healthy starting revision'
  | 'observed candidate digest differs from approved artifact';

/** An expected runtime check failed with a message independent of provider data. */
export class TrialCheckError extends Error {
  constructor(readonly reason: TrialCheckReason) {
    super(reason);
  }
}
