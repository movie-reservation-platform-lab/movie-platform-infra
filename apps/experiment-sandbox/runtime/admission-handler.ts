/**
 * The admission Lambda: the check the workload stack waits for before creating anything.
 *
 * It backs a CloudFormation custom resource that every workload resource depends on, so a
 * deployment without an open, matching lease fails before it allocates anything.
 */

import { HOUR_MS, SANDBOX_LIMITS } from '@movie-platform/experiment-sandbox';

import { controlEnvironment } from './control-environment';
import { readLeaseRow } from './state-table';

/** The fields of a CloudFormation custom resource event this handler reads. */
export interface AdmissionEvent {
  readonly RequestType: 'Create' | 'Update' | 'Delete';
  readonly ResourceProperties?: { readonly ExperimentId?: string };
}

/** CloudFormation's response: the custom resource's stable physical ID. */
export interface AdmissionResponse {
  readonly PhysicalResourceId: string;
}

/**
 * Custom resource handler the workload stack waits for before creating anything.
 * Create and update succeed only while the operator-installed lease is open and matches
 * this deployment's expiry and cutoff; delete always succeeds, so teardown never blocks.
 *
 * @throws Error when the event names another experiment or no valid lease is installed
 */
export async function admissionHandler(event: AdmissionEvent): Promise<AdmissionResponse> {
  const { experimentId, expiresAt, launchCutoffAt } = controlEnvironment();

  if (event.ResourceProperties?.ExperimentId !== experimentId) {
    throw new Error('Wrong experiment');
  }

  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: experimentId };
  }

  const lease = await readLeaseRow();
  const now = Date.now();

  const leaseIsValid =
    lease !== undefined &&
    !lease.disabled &&
    lease.expiresAt === expiresAt &&
    lease.rejectNewWorkAt === launchCutoffAt &&
    now < Date.parse(lease.rejectNewWorkAt) &&
    Date.parse(lease.expiresAt) - now <= SANDBOX_LIMITS.maxLeaseHours * HOUR_MS;

  if (!leaseIsValid) {
    throw new Error('Protected admitted lease required before allocation');
  }

  return { PhysicalResourceId: experimentId };
}
