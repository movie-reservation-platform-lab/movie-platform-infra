/** One hour in milliseconds. */
export const HOUR_MS = 3_600_000;

/** One minute in milliseconds. */
export const MINUTE_MS = 60_000;

/**
 * Fixed limits for one disposable experiment, shared by the record schema,
 * admission policy, CDK app, launcher and trial tool.
 *
 * They live in code, not in the operator record, on purpose: the record is a
 * hand-edited file, so a value there could raise the budget without review.
 * Changing a limit here is a reviewed contract change.
 */
export const SANDBOX_LIMITS = Object.freeze({
  /** The only region a sandbox may use. */
  region: 'eu-central-1',
  /** Highest forecast AWS spend for running the experiment, in US dollars. */
  maxOperatingUsd: 8,
  /** Lowest reserve kept for surprises, in US dollars. */
  minContingencyUsd: 2,
  /** Total experiment budget: operating spend plus contingency, in US dollars. */
  allowanceUsd: 10,
  /** Evidence older than this cannot approve account creation. */
  maxEvidenceAgeHours: 24,
  /** Longest lease, from `startsAt` to `expiresAt`. */
  maxLeaseHours: 4,
  /** Latest point after `startsAt` at which new trial tasks may start. */
  maxNewWorkHours: 3,
  /** Exact gap between the new-work cutoff and lease expiry, so the last run can finish. */
  cleanupWindowHours: 1,
  /** Trial tasks that may run at the same time. */
  maxConcurrentTasks: 4,
  /** Trial task launches allowed over the whole lease. */
  maxTotalLaunches: 16,
  /** Longest a trial step may run; the trial code stops waiting after this. */
  maxRunMinutes: 45,
  /**
   * Extra time before the expiry schedule stops a trial step that is still running past
   * `maxRunMinutes`, so a step finishing on its own is never cut off.
   */
  runLimitGraceMinutes: 5,
  /** A watch heartbeat older than this means the watcher is stale; release is refused. */
  watchHeartbeatMaxAgeSeconds: 30,
} as const);

export type SandboxLimits = typeof SANDBOX_LIMITS;
