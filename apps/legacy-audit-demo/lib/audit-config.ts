export interface AuditConfig {
  /** Explicit disposable-data opt-in, never enabled by a plain cdk destroy. */
  readonly allowAuditDataDeletion: boolean;
  readonly auditRetentionDays: number;
}

function contextBoolean(value: unknown, key: string): boolean {
  if (value === undefined || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  throw new Error(`CDK context "${key}" must be true or false.`);
}

/** Validate the untrusted CDK context consumed by the legacy audit app. */
export function resolveAuditConfig(context: {
  allowAuditDataDeletion?: unknown;
  auditRetentionDays?: unknown;
}): AuditConfig {
  const retentionInput = context.auditRetentionDays === undefined ? 30 : context.auditRetentionDays;
  if (
    (typeof retentionInput !== 'number' && typeof retentionInput !== 'string') ||
    (typeof retentionInput === 'string' && retentionInput.trim().length === 0)
  ) {
    throw new Error('auditRetentionDays must be an integer from 1 through 3650.');
  }
  const days = Number(retentionInput);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new Error('auditRetentionDays must be an integer from 1 through 3650.');
  }
  return {
    allowAuditDataDeletion: contextBoolean(context.allowAuditDataDeletion, 'allowAuditDataDeletion'),
    auditRetentionDays: days,
  };
}
