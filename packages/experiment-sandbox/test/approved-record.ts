import { HOUR_MS, SANDBOX_LIMITS, type SandboxRecord } from '../src';

/** The fixed decision time every policy test uses. */
export const NOW = new Date('2026-10-24T10:00:00Z');

/** UTC timestamp `hours` after {@link NOW}; negative values are in the past. */
export function hoursFromNow(hours: number): string {
  return new Date(NOW.getTime() + hours * HOUR_MS).toISOString();
}

/**
 * A record that passes every allocation and admission rule at {@link NOW}.
 *
 * Tests change one field at a time and expect exactly one blocker.
 */
export function approvedRecord(): SandboxRecord {
  const verifiedAt = hoursFromNow(-1);

  return {
    version: 1,
    id: 'exp-policy-test',
    owner: 'operator',
    region: SANDBOX_LIMITS.region,
    managementTargetFile: '/private/management-target.json',
    managementAccountId: '111111111111',
    sandboxTargetFile: '/private/sandbox-target.json',
    account: {
      email: 'sandbox@example.invalid',
      name: 'exp-policy-test-correlation01',
      correlationId: 'correlation01',
      state: 'ready',
      accountId: '222222222222',
      preparationExpiresAt: hoursFromNow(24),
      capacityVerifiedAt: verifiedAt,
      capacityEvidence: 'organization capacity review',
      recoveryVerifiedAt: verifiedAt,
      recoveryEvidence: 'recovery schedule verified',
    },
    images: {
      good: `111111111111.dkr.ecr.eu-central-1.amazonaws.com/recommendation@sha256:${'a'.repeat(64)}`,
      bad: `111111111111.dkr.ecr.eu-central-1.amazonaws.com/recommendation@sha256:${'b'.repeat(64)}`,
      verifiedAt,
      verificationEvidence: 'both digests checked',
    },
    entitlement: {
      zeroCharge: true,
      expiresAt: hoursFromNow(SANDBOX_LIMITS.maxLeaseHours),
      verifiedAt,
      evidence: 'free plan confirmed',
    },
    cost: {
      operatingUsd: SANDBOX_LIMITS.maxOperatingUsd,
      contingencyUsd: SANDBOX_LIMITS.minContingencyUsd,
      allowanceUsd: SANDBOX_LIMITS.allowanceUsd,
      complete: true,
      forecastAt: verifiedAt,
      evidence: 'regional price worksheet',
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
      stackName: 'exp-policy-test-workload',
      controlStackName: 'exp-policy-test-control',
      resources: [],
      cleanupInstalled: true,
      cleanupVerified: true,
      accessRevoked: false,
      workloadsRemoved: false,
    },
  };
}
