import type { ValidatedAwsAccess } from '@movie-platform/aws-account-preflight';
import type { AuditAccountConfig } from '@movie-platform/audit-account-config';

export class AuditAccountTargetError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AuditAccountTargetError';
  }
}

/** A topology and live SSO target proven to select the same audit account. */
export interface ValidatedAuditAccountTarget {
  readonly config: AuditAccountConfig;
  readonly access: ValidatedAwsAccess;
}

/** Require the validated operator identity to match the configured audit target. */
export function validateAuditAccountTarget(
  config: AuditAccountConfig,
  access: ValidatedAwsAccess,
): ValidatedAuditAccountTarget {
  if (access.target.accountId !== config.auditAccountId) {
    throw new AuditAccountTargetError(
      'the validated AWS target does not match the configured audit account',
    );
  }
  if (access.target.region !== config.region) {
    throw new AuditAccountTargetError(
      'the validated AWS target Region does not match the configured audit Region',
    );
  }

  return Object.freeze({ config, access });
}
