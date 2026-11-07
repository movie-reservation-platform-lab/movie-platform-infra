/**
 * The operator's use cases: create, reconcile and close the sandbox account, install the
 * lease, run cleanup, and capture and finalize the control stack's leftovers.
 *
 * Each use case saves the record's next state through {@link RecordStore} and talks to
 * AWS only through the narrow ports below, so the order of "save intent, then act" can
 * be tested with fakes. `aws-cli.ts` implements the ports with the AWS CLI; `cli.ts`
 * calls these functions.
 */

import {
  assertAdmission,
  type CleanupStatus,
  type RetiredControls,
  type SandboxAccountState,
  type SandboxRecord,
} from '@movie-platform/experiment-sandbox';

import { sanitizedCleanupBlockers } from './cleanup-diagnostics';

/** Saves the operator record. Callers hold the record lock; each save is atomic. */
export interface RecordStore {
  save(record: SandboxRecord): void;
}

/** What AWS Organizations reports about an account creation request. */
export interface AccountResult {
  readonly state: 'requested' | 'ready' | 'failed';
  readonly requestId?: string;
  readonly accountId?: string;
}

/** What one run of the protected cleanup Lambda observed. */
export interface CleanupResult {
  readonly status: CleanupStatus;
  readonly blockers: readonly string[];
  readonly resources: readonly string[];
  readonly accessRevoked: boolean;
  readonly workloadsRemoved: boolean;
}

/** Account states after a closure request; `status` reads these from AWS Organizations. */
const CLOSURE_STATES: readonly SandboxAccountState[] = [
  'closure-intent',
  'closure-unknown',
  'closure-requested',
  'closed',
];

/**
 * Thrown by a port when AWS certainly did not act on the request: a failed preflight, or
 * an explicit rejection such as `AccessDeniedException`. The record can safely return to
 * its previous state, unlike a timeout, where the request may or may not have arrived.
 */
export class RequestNotSubmittedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RequestNotSubmittedError';
  }
}

/** Creating the sandbox account in AWS Organizations (management account). */
export interface AccountCreation {
  /** Runs every check that needs no request to AWS Organizations, such as the SSO preflight. */
  verifyCreate(record: SandboxRecord): Promise<void>;
  /** @throws RequestNotSubmittedError when AWS certainly did not create anything */
  create(record: SandboxRecord): Promise<AccountResult>;
}

/** Looking up an account creation request whose response may have been lost. */
export interface AccountReconciliation {
  reconcile(record: SandboxRecord): Promise<AccountResult>;
}

/** Closing the sandbox account (from the management account). */
export interface AccountClosure {
  /** Read-only checks that must pass before a closure is requested. */
  verifyRetirement(record: SandboxRecord): Promise<void>;
  retire(record: SandboxRecord): Promise<void>;
  retirementStatus(record: SandboxRecord): Promise<'closure-requested' | 'closed'>;
}

/** Installing the lease row, after checking the deployed cleanup safeguards. */
export interface LeaseAdmission {
  admit(record: SandboxRecord): Promise<void>;
}

/** Running the protected cleanup Lambda once. */
export interface SandboxCleanup {
  cleanup(record: SandboxRecord): Promise<CleanupResult>;
}

/** Recording and removing what the control stack leaves behind when it is deleted. */
export interface ControlManifestStore {
  captureControls(record: SandboxRecord, now: Date): Promise<RetiredControls>;
  finalizeControls(record: SandboxRecord, now: Date): Promise<RetiredControls>;
}

/** Every port the operator CLI needs; `AwsCliSandboxCloud` implements all of them. */
export type SandboxCloud = AccountCreation &
  AccountReconciliation &
  AccountClosure &
  LeaseAdmission &
  SandboxCleanup &
  ControlManifestStore;

/**
 * Records creation intent, then asks AWS Organizations for a new sandbox account.
 * Operator-only; see `AwsCliSandboxCloud.create` for who may hold this authority.
 *
 * Preflight checks run before the intent is saved, and an explicit rejection returns the
 * record to `planned`, so neither can lock the account name. Only a truly ambiguous
 * failure (timeout, lost response) leaves the record `unknown`, which `status` reconciles.
 *
 * @returns the record in `requested`, `ready` or `failed`
 * @throws Error when the account was already submitted, a preflight fails or AWS rejects
 *   (record unchanged), or when the outcome is unknown (record saved as `unknown`; the
 *   error says to run `status --execute` and carries the original error as `cause`)
 */
export async function createAccount(
  record: SandboxRecord,
  store: RecordStore,
  cloud: AccountCreation,
): Promise<SandboxRecord> {
  if (record.account.state !== 'planned') {
    throw new Error('Account already submitted; reconcile status before any new create');
  }

  await cloud.verifyCreate(record);

  const intent = withAccountState(record, 'submitting');

  // Must finish atomically before the first network operation.
  store.save(intent);

  let result: AccountResult;

  try {
    result = await cloud.create(intent);
  } catch (error) {
    if (error instanceof RequestNotSubmittedError) {
      store.save(record);
      throw error;
    }

    store.save(withAccountState(intent, 'unknown'));

    throw new Error(
      `Account creation outcome unknown (${errorName(error)}); run status --execute before anything else`,
      { cause: error },
    );
  }

  const updated: SandboxRecord = { ...intent, account: { ...intent.account, ...result } };

  store.save(updated);

  return updated;
}

/**
 * Reads the current status of a previously submitted AWS Organizations account-creation
 * request, verifies that it belongs to this experiment, and saves the result.
 *
 * @throws Error when AWS reports a different request or account than the record holds
 */
export async function reconcileAccount(
  record: SandboxRecord,
  store: RecordStore,
  cloud: AccountReconciliation,
): Promise<SandboxRecord> {
  if (record.account.state === 'planned') {
    throw new Error('No submitted creation intent to reconcile');
  }

  const result = await cloud.reconcile(record);

  const identityChanged =
    (record.account.requestId && result.requestId !== record.account.requestId) ||
    (record.account.accountId && result.accountId !== record.account.accountId);

  if (identityChanged) {
    throw new Error('Established account identity mismatch');
  }

  const updated: SandboxRecord = { ...record, account: { ...record.account, ...result } };

  store.save(updated);

  return updated;
}

/**
 * The `status` command: reconciles a creation request, or, after a closure request,
 * reads whether the account is pending closure or closed.
 */
export async function refreshAccountStatus(
  record: SandboxRecord,
  store: RecordStore,
  cloud: AccountReconciliation & Pick<AccountClosure, 'retirementStatus'>,
): Promise<SandboxRecord> {
  if (!CLOSURE_STATES.includes(record.account.state)) {
    return reconcileAccount(record, store, cloud);
  }

  const updated = withAccountState(record, await cloud.retirementStatus(record));

  store.save(updated);

  return updated;
}

/**
 * Installs the lease once every admission rule holds, which lets the workload deploy and
 * trial tasks start. The record itself does not change.
 *
 * @throws Error listing every admission blocker, or when a deployed safeguard is missing
 */
export async function admitLease(
  record: SandboxRecord,
  cloud: LeaseAdmission,
  now: Date,
): Promise<void> {
  assertAdmission(record, now);
  await cloud.admit(record);
}

/**
 * Runs the protected cleanup once and saves what it observed. The workload counts as
 * removed only when cleanup reports `COMPLETE` with nothing left and no blockers.
 */
export async function cleanupSandbox(
  record: SandboxRecord,
  store: RecordStore,
  cloud: SandboxCleanup,
  now: Date,
): Promise<SandboxRecord> {
  if (record.account.state !== 'ready') {
    throw new Error('Cleanup requires a ready dedicated account');
  }

  const result = await cloud.cleanup(record);

  const removed =
    result.status === 'COMPLETE' &&
    result.accessRevoked &&
    result.workloadsRemoved &&
    result.resources.length === 0 &&
    result.blockers.length === 0;

  const updated: SandboxRecord = {
    ...record,
    inventory: {
      ...record.inventory,
      resources: [...result.resources],
      cleanupStatus: result.status,
      cleanupBlockers: sanitizedCleanupBlockers(result.blockers),
      accessRevoked: result.accessRevoked,
      workloadsRemoved: removed,
      observedAt: now.toISOString(),
    },
  };

  store.save(updated);

  return updated;
}

/** Records the control stack's retained resources before the stack is deleted. */
export async function captureControlManifest(
  record: SandboxRecord,
  store: RecordStore,
  cloud: ControlManifestStore,
  now: Date,
): Promise<SandboxRecord> {
  const retiredControls = await cloud.captureControls(record, now);

  return saveRetiredControls(record, store, retiredControls);
}

/**
 * Deletes the captured leftovers after the control stack is gone and records which are
 * confirmed absent. Repeat until `verifiedAbsentAt` is set.
 */
export async function finalizeControlManifest(
  record: SandboxRecord,
  store: RecordStore,
  cloud: ControlManifestStore,
  now: Date,
): Promise<SandboxRecord> {
  const retiredControls = await cloud.finalizeControls(record, now);

  return saveRetiredControls(record, store, retiredControls);
}

/**
 * Requests closure of the sandbox account, after verified workload and control cleanup.
 * The intent is saved before the request; if the request fails, the record becomes
 * `closure-unknown` and `status` reads the real state instead of resubmitting.
 *
 * @throws Error when cleanup is not verified, a read-only check fails, or the request fails
 */
export async function retireAccount(
  record: SandboxRecord,
  store: RecordStore,
  cloud: Pick<AccountClosure, 'verifyRetirement' | 'retire'>,
): Promise<SandboxRecord> {
  const { inventory, account } = record;

  const cleanupVerified =
    inventory.workloadsRemoved &&
    inventory.accessRevoked &&
    inventory.resources.length === 0 &&
    inventory.observedAt !== undefined;

  if (!cleanupVerified) {
    throw new Error('Verified cleanup required before account retirement');
  }

  if (account.state !== 'ready' || !account.accountId) {
    throw new Error('Only a ready dedicated account may be retired');
  }

  if (!inventory.retiredControls?.verifiedAbsentAt) {
    throw new Error(
      'Verified control cleanup required; capture before stack deletion, then finalize-controls',
    );
  }

  // A failed read-only prerequisite must not masquerade as an ambiguous close submission.
  await cloud.verifyRetirement(record);

  const intent = withAccountState(record, 'closure-intent');

  store.save(intent);

  try {
    await cloud.retire(record);
  } catch (error) {
    saveClosureUnknown(intent, store, error);
  }

  const accepted = withAccountState(intent, 'closure-requested');

  store.save(accepted);

  return accepted;
}

/**
 * A printable name for an error: its service code when it has one (for example
 * `ServiceException`), else its class name. Never its message, which may hold account data.
 */
function errorName(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'unexpected failure';
  }

  const code: unknown = (error as { code?: unknown }).code;

  return typeof code === 'string' ? code : error.name;
}

function withAccountState(record: SandboxRecord, state: SandboxAccountState): SandboxRecord {
  return { ...record, account: { ...record.account, state } };
}

function saveRetiredControls(
  record: SandboxRecord,
  store: RecordStore,
  retiredControls: RetiredControls,
): SandboxRecord {
  const updated: SandboxRecord = { ...record, inventory: { ...record.inventory, retiredControls } };

  store.save(updated);

  return updated;
}

/**
 * Saves `closure-unknown` and rethrows the request error. If that save fails too, both
 * errors are kept, so the closure failure is never hidden behind a file error.
 */
function saveClosureUnknown(
  intent: SandboxRecord,
  store: RecordStore,
  requestError: unknown,
): never {
  try {
    store.save(withAccountState(intent, 'closure-unknown'));
  } catch (saveError) {
    throw new AggregateError(
      [requestError, saveError],
      'Closure request failed and its unknown state could not be saved',
      { cause: saveError },
    );
  }

  throw requestError;
}
