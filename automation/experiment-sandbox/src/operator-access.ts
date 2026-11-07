/**
 * Picks and checks the AWS identity for an operator action. Account lifecycle runs with
 * the management account's SSO profile; everything inside the sandbox runs with the
 * sandbox account's profile. Both are verified against the record before any AWS call.
 */

import { validateAwsAccess, type ValidatedAwsAccess } from '@movie-platform/aws-account-preflight';
import type { SandboxRecord } from '@movie-platform/experiment-sandbox';

/** Which account an operation acts in. */
export type OperatorScope = 'management' | 'sandbox';

/**
 * Runs the repository's SSO preflight for the record's target file and checks that the
 * profile is the exact account and region the record names.
 *
 * @throws Error when the target file is missing, the preflight fails, or the profile
 *   points at another account or region
 */
export function operatorAccess(record: SandboxRecord, scope: OperatorScope): ValidatedAwsAccess {
  const targetFile =
    scope === 'management' ? record.managementTargetFile : record.sandboxTargetFile;

  if (!targetFile) {
    throw new Error('Sandbox target file required');
  }

  const access = validateAwsAccess({ ...process.env, MOVIE_PLATFORM_AWS_TARGET_FILE: targetFile });

  const expectedAccountId =
    scope === 'management' ? record.managementAccountId : record.account.accountId;

  if (access.target.accountId !== expectedAccountId || access.target.region !== record.region) {
    throw new Error('Validated AWS operator target does not match exact record account/region');
  }

  return access;
}

/**
 * The sandbox account ID of a record whose account exists.
 *
 * @throws Error when the record has no account ID yet
 */
export function sandboxAccountId(record: SandboxRecord): string {
  if (!record.account.accountId) {
    throw new Error('Record has no sandbox account ID; reconcile account status first');
  }

  return record.account.accountId;
}
