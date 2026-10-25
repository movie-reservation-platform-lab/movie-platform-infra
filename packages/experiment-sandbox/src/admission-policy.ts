import { parseSandboxRecord } from './parse-record';
import { HOUR_MS, SANDBOX_LIMITS } from './sandbox-limits';
import type { SandboxRecord } from './sandbox-record';

const MAX_EVIDENCE_AGE_MS = SANDBOX_LIMITS.maxEvidenceAgeHours * HOUR_MS;

/** The outcome of re-validating a caller's record before applying policy. */
type RecordCheck =
  | { readonly valid: true; readonly record: SandboxRecord }
  | { readonly valid: false; readonly blockers: string[] };

/**
 * Lists every reason the sandbox account must not be created yet.
 *
 * Each gate stands alone: a cheap forecast cannot stand in for missing artifact or
 * entitlement evidence. Every piece of evidence must be recent
 * (`SANDBOX_LIMITS.maxEvidenceAgeHours`).
 *
 * @param record - re-validated here, because callers may pass an edited copy
 * @param now - the decision time; injected so tests control the clock
 * @returns human-readable blockers; empty means allocation may proceed
 */
export function allocationBlockers(record: SandboxRecord, now: Date): string[] {
  const check = checkRecord(record, now);

  return check.valid ? allocationRuleBlockers(check.record, now) : check.blockers;
}

/**
 * Lists every reason a trial must not run in the sandbox now.
 *
 * That is all allocation blockers, plus a ready account, a started lease, and verified
 * cleanup. A finished sandbox (access revoked or workloads removed) is never readmitted.
 *
 * @returns human-readable blockers; empty means the trial may run
 */
export function admissionBlockers(record: SandboxRecord, now: Date): string[] {
  const check = checkRecord(record, now);

  if (!check.valid) {
    return check.blockers;
  }

  return [
    ...allocationRuleBlockers(check.record, now),
    ...admissionRuleBlockers(check.record, now),
  ];
}

/**
 * Throws unless {@link admissionBlockers} is empty.
 *
 * @throws Error whose message joins every blocker with `; `
 */
export function assertAdmission(record: SandboxRecord, now: Date): void {
  const blockers = admissionBlockers(record, now);

  if (blockers.length > 0) {
    throw new Error(blockers.join('; '));
  }
}

/**
 * Validates the record and the clock once, so the rule functions can trust both.
 *
 * Returns the parsed copy, never the caller's object, so later rules read checked data.
 */
function checkRecord(record: SandboxRecord, now: Date): RecordCheck {
  let checked: SandboxRecord;

  try {
    checked = parseSandboxRecord(record);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'validation failed';

    return { valid: false, blockers: [`invalid record: ${reason}`] };
  }

  if (!Number.isFinite(now.getTime())) {
    return { valid: false, blockers: ['invalid current time'] };
  }

  return { valid: true, record: checked };
}

/** Evidence, budget and deadline rules that must hold before account creation. */
function allocationRuleBlockers(record: SandboxRecord, now: Date): string[] {
  const blockers: string[] = [];
  const { cost, entitlement, images, account, lease } = record;

  const entitlementCoversLease =
    entitlement.zeroCharge &&
    entitlement.verifiedAt !== undefined &&
    entitlement.evidence !== undefined &&
    Date.parse(entitlement.expiresAt) >= Date.parse(lease.expiresAt);

  if (!entitlementCoversLease) {
    blockers.push('zero-charge Harness entitlement verified through lease expiry required');
  }

  if (!images.verifiedAt || !images.verificationEvidence) {
    blockers.push('good/bad immutable artifact pair verification evidence required');
  }

  const { maxOperatingUsd, minContingencyUsd, allowanceUsd } = SANDBOX_LIMITS;

  const forecastFits =
    cost.complete &&
    cost.forecastAt !== undefined &&
    cost.evidence !== undefined &&
    cost.operatingUsd <= maxOperatingUsd &&
    cost.contingencyUsd >= minContingencyUsd &&
    cost.operatingUsd + cost.contingencyUsd <= allowanceUsd;

  if (!forecastFits) {
    blockers.push(
      `complete forecast must fit $${maxOperatingUsd} operating plus $${minContingencyUsd} contingency within $${allowanceUsd}`,
    );
  }

  if (!account.recoveryVerifiedAt || !account.recoveryEvidence) {
    blockers.push('trusted independent account preparation recovery schedule evidence required');
  }

  if (!account.capacityVerifiedAt || !account.capacityEvidence) {
    blockers.push('organization capacity and target verification evidence required');
  }

  const evidenceTimes = [
    entitlement.verifiedAt,
    images.verifiedAt,
    cost.forecastAt,
    account.capacityVerifiedAt,
    account.recoveryVerifiedAt,
  ];

  if (evidenceTimes.some((timestamp) => timestamp && !isCurrentEvidence(timestamp, now))) {
    blockers.push(
      `pre-allocation evidence must be current (within ${SANDBOX_LIMITS.maxEvidenceAgeHours} hours)`,
    );
  }

  if (now.getTime() >= Date.parse(account.preparationExpiresAt)) {
    blockers.push('account preparation recovery deadline expired');
  }

  if (now.getTime() >= Date.parse(lease.rejectNewWorkAt)) {
    blockers.push('lease rejects new work');
  }

  return blockers;
}

/** Account, lease and cleanup rules that must also hold before a trial runs. */
function admissionRuleBlockers(record: SandboxRecord, now: Date): string[] {
  const blockers: string[] = [];
  const { account, inventory, lease } = record;

  if (account.state !== 'ready' || !account.accountId || !record.sandboxTargetFile) {
    blockers.push('ready dedicated sandbox account and target file required');
  }

  if (now.getTime() < Date.parse(lease.startsAt)) {
    blockers.push('lease has not started');
  }

  const cleanupReady =
    inventory.cleanupInstalled &&
    inventory.cleanupVerified &&
    inventory.controlStackName !== undefined &&
    inventory.stackName !== undefined;

  if (!cleanupReady) {
    blockers.push('independent cleanup must be installed and verified before admission');
  }

  if (inventory.accessRevoked || inventory.workloadsRemoved) {
    blockers.push('finished sandbox cannot be readmitted');
  }

  return blockers;
}

/** Evidence counts only if it is not from the future and is recent enough. */
function isCurrentEvidence(timestamp: string, now: Date): boolean {
  const age = now.getTime() - Date.parse(timestamp);

  return age >= 0 && age <= MAX_EVIDENCE_AGE_MS;
}
