/**
 * Cleanup's decisions, free of AWS: the order of teardown steps and when the workload
 * counts as gone. `cleanup-handler.ts` connects the ports below to AWS.
 */

import { CLEANUP_BLOCKERS, type CleanupStatus } from '@movie-platform/experiment-sandbox';

/** Cleanup's own outcomes; `WAITING_FOR_EXPIRY` is decided before cleanup starts. */
export type CleanupOutcome = Exclude<CleanupStatus, 'WAITING_FOR_EXPIRY'>;

/** The result of one cleanup run, saved to the inventory bucket and returned to the caller. */
export interface CleanupState {
  experimentId: string;
  status: CleanupOutcome;
  /** Texts from `CLEANUP_BLOCKERS` only; never raw AWS errors. */
  blockers: string[];
  /** Workload resources still observed after this run. */
  resources: string[];
  /** Admission is disabled, so no new task can start. */
  accessRevoked: boolean;
  /** A fresh observation after deletion found nothing left. */
  workloadsRemoved: boolean;
}

/** What one look at AWS found of the workload. */
export interface WorkloadDiscovery {
  resources: string[];
  stackExists: boolean;
  /** The stack is being created or updated, so it cannot be deleted yet. */
  provisioning: boolean;
}

/** The teardown steps, named in failure reports. */
export type CleanupStep =
  | 'disable admission'
  | 'read inventory'
  | 'discover workload'
  | 'stop tasks'
  | 'remove task definitions'
  | 'delete stack'
  | 'cancel stack update'
  | 'confirm removal';

/** Everything cleanup needs from AWS, so its decisions can be tested with fakes. */
export interface CleanupPorts {
  disableAdmission(): Promise<void>;
  /** Resources recorded by earlier runs. */
  inventory(): Promise<string[]>;
  discover(): Promise<WorkloadDiscovery>;
  stopTasks(): Promise<void>;
  /** Cancels a running stack update, so the stack rolls back to a deletable state. No-op otherwise. */
  cancelStackUpdate(): Promise<void>;
  deleteStack(): Promise<void>;
  /**
   * Deregisters task definition revisions the release step registered outside
   * CloudFormation; revisions the stack owns are left to stack deletion.
   */
  removeExternalTaskDefinitions(): Promise<void>;
  save(state: CleanupState): Promise<void>;
  /** Records why a step failed, in the protected cleanup log. */
  reportFailure(step: CleanupStep, error: unknown): void;
}

/**
 * Runs one teardown pass and saves its result. Safe to repeat: each run disables
 * admission, stops what is running, deletes what is left, and looks again.
 *
 * `COMPLETE` comes only from a fresh observation that finds nothing, never from a
 * delete request being accepted. Failures become `BLOCKED` with a safe blocker text;
 * the next scheduled run retries.
 */
export async function cleanup(experimentId: string, ports: CleanupPorts): Promise<CleanupState> {
  const state: CleanupState = {
    experimentId,
    status: 'DELETING',
    blockers: [],
    resources: [],
    accessRevoked: false,
    workloadsRemoved: false,
  };

  try {
    await ports.disableAdmission();
    state.accessRevoked = true;
  } catch (error) {
    ports.reportFailure('disable admission', error);
    state.blockers.push(CLEANUP_BLOCKERS.admissionNotDisabled);
  }

  // Without confirmed admission shutdown, deleting compute can race new task launches.
  if (state.accessRevoked) {
    await removeWorkload(state, ports);
  }

  state.status = outcomeOf(state);
  await ports.save(state);

  return state;
}

/**
 * Stops, deregisters and deletes, then records what a fresh look still finds. Mutates `state`.
 *
 * While the stack is still being created, updated or rolled back, cleanup only cancels a
 * running update and reports `BLOCKED`: stopping tasks or deregistering task definitions
 * under an in-progress deployment causes churn and unpredictable stack states. Admission
 * is already disabled, so nothing new starts; the next schedule run tears down once the
 * stack has settled.
 */
async function removeWorkload(state: CleanupState, ports: CleanupPorts): Promise<void> {
  let step: CleanupStep = 'read inventory';

  try {
    const inventory = await ports.inventory();

    step = 'discover workload';

    const found = await ports.discover();

    state.resources = [...new Set([...inventory, ...found.resources])];

    if (found.provisioning) {
      step = 'cancel stack update';
      await ports.cancelStackUpdate();
      state.blockers.push(CLEANUP_BLOCKERS.provisioningActive);

      return;
    }

    step = 'stop tasks';
    await ports.stopTasks();

    step = 'remove task definitions';
    await ports.removeExternalTaskDefinitions();

    if (found.stackExists) {
      step = 'delete stack';
      await ports.deleteStack();
    }

    step = 'confirm removal';

    const after = await ports.discover();

    state.resources = after.resources;

    state.workloadsRemoved =
      !after.stackExists && !after.provisioning && after.resources.length === 0;
  } catch (error) {
    ports.reportFailure(step, error);
    state.blockers.push(CLEANUP_BLOCKERS.awsOperationFailed);
  }
}

function outcomeOf(state: CleanupState): CleanupOutcome {
  if (state.blockers.length > 0) {
    return 'BLOCKED';
  }

  return state.workloadsRemoved ? 'COMPLETE' : 'DELETING';
}
