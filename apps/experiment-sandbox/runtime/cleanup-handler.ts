/**
 * The cleanup Lambda: connects cleanup's decisions (`cleanup.ts`) to AWS.
 *
 * The expiry schedule calls it every five minutes and the operator can call it directly.
 * It disables the lease, stops trial tasks, removes task definitions, deletes the
 * workload stack with the delete-only role, and saves each run's result in the
 * inventory bucket.
 */

import { DeleteStackCommand, CancelUpdateStackCommand } from '@aws-sdk/client-cloudformation';
import {
  DeleteTaskDefinitionsCommand,
  DeregisterTaskDefinitionCommand,
  StopTaskCommand,
} from '@aws-sdk/client-ecs';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { parseCleanupRequest } from '@movie-platform/experiment-sandbox';
import { z } from 'zod';

import { cloudFormation, ecs, s3 } from './aws-clients';
import { cleanup, type CleanupPorts, type CleanupState, type CleanupStep } from './cleanup';
import { controlEnvironment } from './control-environment';
import { disableLease } from './state-table';
import {
  describeWorkloadStack,
  listExperimentTaskDefinitions,
  listStackResourceIds,
  listWorkloadTaskArns,
} from './workload-observer';

/** ECS deletes at most ten task definition revisions per DeleteTaskDefinitions call. */
const DELETE_TASK_DEFINITIONS_BATCH_SIZE = 10;

/** Longest error message kept in a failure report; AWS messages can be long. */
const MAX_FAILURE_MESSAGE_LENGTH = 500;

/** A schedule run before lease expiry: nothing is touched. */
export interface WaitingForExpiry {
  readonly experimentId: string;
  readonly status: 'WAITING_FOR_EXPIRY';
  readonly blockers: [];
  readonly resources: [];
  readonly accessRevoked: false;
  readonly workloadsRemoved: false;
}

/** The part of a saved cleanup state that later runs read back. */
const savedInventorySchema = z.object({ resources: z.array(z.string()) });

/**
 * Lambda entry point for the 5-minute schedule and the operator's `cleanup --execute`.
 * Schedule runs wait for lease expiry; operator runs start cleanup at once.
 *
 * @throws Error when the event is invalid or names another experiment
 */
export async function cleanupHandler(event: unknown): Promise<CleanupState | WaitingForExpiry> {
  const { experimentId, expiresAt } = controlEnvironment();
  const request = parseCleanupRequest(event);

  if (request.experimentId !== experimentId) {
    throw new Error('Exact registered experiment ID required');
  }

  if (request.scheduled && Date.now() < Date.parse(expiresAt)) {
    return {
      experimentId,
      status: 'WAITING_FOR_EXPIRY',
      blockers: [],
      resources: [],
      accessRevoked: false,
      workloadsRemoved: false,
    };
  }

  return cleanup(experimentId, awsCleanupPorts());
}

/** Cleanup's ports, backed by DynamoDB, ECS, CloudFormation and the inventory bucket. */
function awsCleanupPorts(): CleanupPorts {
  return {
    disableAdmission: disableLease,
    inventory: readSavedInventory,
    discover: async () => {
      const stack = await describeWorkloadStack();
      const stackResourceIds = stack ? await listStackResourceIds() : [];
      const taskArns = await listWorkloadTaskArns();

      // While the stack exists it still owns its task definitions; once it is gone,
      // every remaining revision of this experiment counts, in any state.
      const taskDefinitionArns = await listExperimentTaskDefinitions(
        stack ? ['ACTIVE'] : ['ACTIVE', 'INACTIVE', 'DELETE_IN_PROGRESS'],
        Boolean(stack),
      );

      const stackStatus = stack?.StackStatus ?? '';

      return {
        resources: [...new Set([...stackResourceIds, ...taskArns, ...taskDefinitionArns])],
        stackExists: Boolean(stack),
        provisioning: stackStatus.endsWith('_IN_PROGRESS') && stackStatus !== 'DELETE_IN_PROGRESS',
      };
    },
    stopTasks: stopTrialTasks,
    deleteStack: deleteWorkloadStack,
    removeExternalTaskDefinitions: removeReleaseTaskDefinitions,
    save: saveCleanupState,
    reportFailure: logCleanupFailure,
  };
}

/** Resources an earlier run recorded in the inventory bucket; none before the first run. */
async function readSavedInventory(): Promise<string[]> {
  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: controlEnvironment().inventoryBucketName,
        Key: inventoryKey(),
      }),
    );

    const body = await response.Body?.transformToString();

    return body ? savedInventorySchema.parse(JSON.parse(body)).resources : [];
  } catch (error) {
    if (error instanceof Error && ['NoSuchKey', 'NotFound'].includes(error.name)) {
      return [];
    }

    throw error;
  }
}

/** Stops every task in the cluster and cancels an in-progress stack update. */
async function stopTrialTasks(): Promise<void> {
  const { clusterArn, workloadStackName } = controlEnvironment();

  for (const task of await listWorkloadTaskArns()) {
    await ecs.send(
      new StopTaskCommand({ cluster: clusterArn, task, reason: 'Protected experiment cleanup' }),
    );
  }

  const stack = await describeWorkloadStack();

  if (stack?.StackStatus === 'UPDATE_IN_PROGRESS') {
    await cloudFormation.send(new CancelUpdateStackCommand({ StackName: workloadStackName }));
  }
}

/** Requests stack deletion with the delete-only service role, unless deletion is already running. */
async function deleteWorkloadStack(): Promise<void> {
  const { workloadStackName, workloadDeletionRoleArn } = controlEnvironment();
  const stack = await describeWorkloadStack();

  if (stack?.StackStatus === 'DELETE_IN_PROGRESS') {
    return;
  }

  await cloudFormation.send(
    new DeleteStackCommand({ StackName: workloadStackName, RoleARN: workloadDeletionRoleArn }),
  );
}

/**
 * Deregisters task definitions CloudFormation does not own, then, once the stack is gone,
 * deletes every inactive revision, including releases registered outside CloudFormation.
 *
 * @throws Error when ECS reports any revision it could not delete
 */
async function removeReleaseTaskDefinitions(): Promise<void> {
  const stack = await describeWorkloadStack();

  for (const taskDefinition of await listExperimentTaskDefinitions(['ACTIVE'], Boolean(stack))) {
    await ecs.send(new DeregisterTaskDefinitionCommand({ taskDefinition }));
  }

  if (stack) {
    return;
  }

  const inactive = await listExperimentTaskDefinitions(['INACTIVE']);

  for (let offset = 0; offset < inactive.length; offset += DELETE_TASK_DEFINITIONS_BATCH_SIZE) {
    const batch = inactive.slice(offset, offset + DELETE_TASK_DEFINITIONS_BATCH_SIZE);
    const response = await ecs.send(new DeleteTaskDefinitionsCommand({ taskDefinitions: batch }));

    if (response.failures?.length) {
      throw new Error('Task definition deletion remains blocked');
    }
  }
}

/** Logs the state (the `BLOCKED` alarm reads this line) and saves it for the next run. */
async function saveCleanupState(state: CleanupState): Promise<void> {
  console.log(JSON.stringify(state));

  await s3.send(
    new PutObjectCommand({
      Bucket: controlEnvironment().inventoryBucketName,
      Key: inventoryKey(),
      Body: JSON.stringify({ ...state, observedAt: new Date().toISOString() }),
      ContentType: 'application/json',
    }),
  );
}

/**
 * Writes the failed step and the AWS error to the protected cleanup log. The operator
 * record only gets the safe blocker text; this line says why, for example
 * `AccessDeniedException` on `delete stack`.
 */
function logCleanupFailure(step: CleanupStep, error: unknown): void {
  const errorName = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message.slice(0, MAX_FAILURE_MESSAGE_LENGTH) : '';

  console.error(JSON.stringify({ event: 'cleanup-step-failed', step, errorName, message }));
}

function inventoryKey(): string {
  return `inventory/${controlEnvironment().experimentId}.json`;
}
