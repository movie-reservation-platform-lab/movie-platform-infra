/**
 * The AWS CLI implementation of the operator's ports (`SandboxCloud` in `lifecycle.ts`).
 *
 * Each method picks the right identity (management or sandbox account, checked against
 * the record by `operatorAccess`) and delegates to the module that owns the AWS calls.
 * Credentials are never returned or stored.
 */

import type { RetiredControls, SandboxRecord } from '@movie-platform/experiment-sandbox';

import { runAws, type AwsRunner } from './aws-runner';
import { invokeCleanup } from './cleanup-invocation';
import { captureControls, finalizeControls, verifyControlsAbsent } from './control-inventory';
import { installLease } from './lease-admission';
import {
  RequestNotSubmittedError,
  type AccountResult,
  type CleanupResult,
  type SandboxCloud,
} from './lifecycle';
import { operatorAccess } from './operator-access';
import {
  assertCorrelatedAccountName,
  findAccountRequest,
  readClosureState,
  requestAccount,
  requestAccountClosure,
} from './organizations';

export type { AwsRunner } from './aws-runner';

/** Operator actions against AWS through the AWS CLI; tests pass a fake runner. */
export class AwsCliSandboxCloud implements SandboxCloud {
  constructor(private readonly run: AwsRunner = runAws) {}

  /**
   * Checks everything that needs no request: the management-account SSO preflight and
   * the account name's correlation suffix.
   *
   * @throws RequestNotSubmittedError when a check fails; nothing was sent to AWS
   */
  async verifyCreate(record: SandboxRecord): Promise<void> {
    try {
      operatorAccess(record, 'management');
      assertCorrelatedAccountName(record);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'preflight failed';

      throw new RequestNotSubmittedError(reason, { cause: error });
    }
  }

  /**
   * Creates the sandbox account through AWS Organizations. Operator-only:
   * runs with the management-account SSO profile, never from inside the sandbox.
   *
   * The Harness delegate and trial tasks must never get Organizations access;
   * their only path into the sandbox is invoking the protected launcher.
   * Today this is kept by separate credentials (`operatorAccess` checks the
   * management account ID), the delegate image contents (no operator code),
   * and the workspace boundary check (automation workspaces cannot depend on
   * each other).
   *
   * TODO: enforce it in IAM/SCP and a CI check instead of relying on structure.
   */
  async create(record: SandboxRecord): Promise<AccountResult> {
    const access = operatorAccess(record, 'management');

    assertCorrelatedAccountName(record);

    return requestAccount(this.run, access, record);
  }

  async reconcile(record: SandboxRecord): Promise<AccountResult> {
    return findAccountRequest(this.run, operatorAccess(record, 'management'), record);
  }

  async admit(record: SandboxRecord): Promise<void> {
    installLease(this.run, operatorAccess(record, 'sandbox'), record);
  }

  async cleanup(record: SandboxRecord): Promise<CleanupResult> {
    return invokeCleanup(this.run, operatorAccess(record, 'sandbox'), record);
  }

  async captureControls(record: SandboxRecord, now: Date): Promise<RetiredControls> {
    return captureControls(record, operatorAccess(record, 'sandbox'), this.run, now);
  }

  async finalizeControls(record: SandboxRecord, now: Date): Promise<RetiredControls> {
    return finalizeControls(record, operatorAccess(record, 'sandbox'), this.run, now);
  }

  async verifyRetirement(record: SandboxRecord): Promise<void> {
    await verifyControlsAbsent(record, operatorAccess(record, 'sandbox'), this.run);
  }

  /** Requests account closure. `retireAccount` runs `verifyRetirement` first. */
  async retire(record: SandboxRecord): Promise<void> {
    requestAccountClosure(this.run, operatorAccess(record, 'management'), record);
  }

  async retirementStatus(record: SandboxRecord): Promise<'closure-requested' | 'closed'> {
    return readClosureState(this.run, operatorAccess(record, 'management'), record);
  }
}
