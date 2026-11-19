/**
 * The cleanup Lambda: connects cleanup's decisions (`cleanup.ts`) to AWS.
 *
 * The expiry schedule calls it every five minutes and the operator can call it directly.
 * Before lease expiry a schedule run only stops trial steps past their run limit
 * (`run-limit.ts`). After expiry it disables the lease, stops trial tasks, removes task definitions, deletes the
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
import { parseCleanupRequest, sandboxTrialTaskFamilies } from '@movie-platform/experiment-sandbox';
import { z } from 'zod';

import { cloudFormation, ecs, s3 } from './aws-clients';
import { cleanup, type CleanupPorts, type CleanupState, type CleanupStep } from './cleanup';
import { controlEnvironment } from './control-environment';
import { overdueTrialTaskArns } from './run-limit';
import { disableLease } from './state-table';
import {
  describeWorkloadStack,
  describeWorkloadTasks,
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
    await stopOverdueTrialTasks();

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
    stopTasks: stopWorkloadTasks,
    cancelStackUpdate: cancelWorkloadStackUpdate,
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

/**
 * Stops trial steps that have run past their limit, so a hung step fails instead of
 * blocking the trial until lease expiry. Service tasks are never touched.
 */
async function stopOverdueTrialTasks(): Promise<void> {
  const { clusterArn, experimentId } = controlEnvironment();
  const tasks = await describeWorkloadTasks(await listWorkloadTaskArns());
  const trialFamilies = new Set(sandboxTrialTaskFamilies(experimentId));

  for (const task of overdueTrialTaskArns(tasks, trialFamilies, Date.now())) {
    await ecs.send(
      new StopTaskCommand({
        cluster: clusterArn,
        task,
        reason: 'Trial step exceeded its run limit',
      }),
    );

    console.log(JSON.stringify({ event: 'trial-task-stopped', reason: 'run limit', task }));
  }
}

/** Stops every task in the workload cluster: trial steps, the service and the delegate. */
async function stopWorkloadTasks(): Promise<void> {
  const { clusterArn } = controlEnvironment();

  for (const task of await listWorkloadTaskArns()) {
    await ecs.send(
      new StopTaskCommand({ cluster: clusterArn, task, reason: 'Protected experiment cleanup' }),
    );
  }
}

/** Cancels the workload stack's update if one is running; any other state is left alone. */
async function cancelWorkloadStackUpdate(): Promise<void> {
  const stack = await describeWorkloadStack();

  if (stack?.StackStatus === 'UPDATE_IN_PROGRESS') {
    await cloudFormation.send(
      new CancelUpdateStackCommand({ StackName: controlEnvironment().workloadStackName }),
    );
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
 * Deregisters the recommendation revisions the release step registered outside
 * CloudFormation, then, once the stack is gone, deletes every inactive revision.
 * While the stack exists, the revisions it owns are left for stack deletion.
 *
 * @throws Error when ECS reports any revision it could not delete
 */
async function removeReleaseTaskDefinitions(): Promise<void> {
  const stack = await describeWorkloadStack();
  const stackOwned = new Set(stack ? await listStackResourceIds() : []);
  const active = await listExperimentTaskDefinitions(['ACTIVE'], Boolean(stack));

  for (const taskDefinition of active.filter((arn) => !stackOwned.has(arn))) {
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
