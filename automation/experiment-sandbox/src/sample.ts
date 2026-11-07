/**
 * The synthetic record template that `sample` prints and `prepare` writes. It is
 * deliberately unapproved: placeholders for every operator value, and no evidence, so
 * every allocation blocker stays visible until the operator fills it in.
 */

import { HOUR_MS, SANDBOX_LIMITS, type SandboxRecord } from '@movie-platform/experiment-sandbox';

const SAMPLE_EXPERIMENT_ID = 'exp-harness-buy-check';

/** Placeholder management account; the operator replaces it with the real one. */
const PLACEHOLDER_ACCOUNT_ID = '111111111111';

/** Unique suffix that ties the account name to its creation request. */
const SAMPLE_CORRELATION_ID = 'example0001';

const SAMPLE_IMAGE_REPOSITORY = `${PLACEHOLDER_ACCOUNT_ID}.dkr.ecr.${SANDBOX_LIMITS.region}.amazonaws.com/recommendation`;

/** Hours the operator has to finish account preparation before recovery applies. */
const PREPARATION_WINDOW_HOURS = 24;

/** A synthetic, unapproved record whose lease starts at `now`. Never invents evidence. */
export function sampleRecord(now: Date): SandboxRecord {
  const hoursFromNow = (hours: number) => new Date(now.getTime() + hours * HOUR_MS).toISOString();

  return {
    version: 1,
    id: SAMPLE_EXPERIMENT_ID,
    owner: 'REPLACE_WITH_OPERATOR',
    region: SANDBOX_LIMITS.region,
    managementTargetFile: '/REPLACE_OUTSIDE_GIT/management-target.json',
    managementAccountId: PLACEHOLDER_ACCOUNT_ID,
    account: {
      email: 'replace@example.invalid',
      name: `${SAMPLE_EXPERIMENT_ID}-${SAMPLE_CORRELATION_ID}`,
      correlationId: SAMPLE_CORRELATION_ID,
      state: 'planned',
      preparationExpiresAt: hoursFromNow(PREPARATION_WINDOW_HOURS),
    },
    images: {
      good: `${SAMPLE_IMAGE_REPOSITORY}@sha256:${'a'.repeat(64)}`,
      bad: `${SAMPLE_IMAGE_REPOSITORY}@sha256:${'b'.repeat(64)}`,
    },
    entitlement: { zeroCharge: false, expiresAt: hoursFromNow(SANDBOX_LIMITS.maxLeaseHours) },
    cost: {
      operatingUsd: SANDBOX_LIMITS.maxOperatingUsd,
      contingencyUsd: SANDBOX_LIMITS.minContingencyUsd,
      allowanceUsd: SANDBOX_LIMITS.allowanceUsd,
      complete: false,
    },
    lease: {
      startsAt: hoursFromNow(0),
      expiresAt: hoursFromNow(SANDBOX_LIMITS.maxLeaseHours),
      rejectNewWorkAt: hoursFromNow(SANDBOX_LIMITS.maxNewWorkHours),
      maxConcurrentTasks: SANDBOX_LIMITS.maxConcurrentTasks,
      maxTotalLaunches: SANDBOX_LIMITS.maxTotalLaunches,
      maxRunMinutes: SANDBOX_LIMITS.maxRunMinutes,
    },
    inventory: {
      resources: [],
      cleanupInstalled: false,
      cleanupVerified: false,
      accessRevoked: false,
      workloadsRemoved: false,
    },
  };
}
