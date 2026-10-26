/**
 * The launcher Lambda: connects the launcher's decisions (`launcher.ts`) to AWS.
 *
 * It reads and writes the lease row in DynamoDB, resolves the trusted task recipe from
 * the workload stack's outputs, and starts and observes trial tasks in ECS.
 */

import { createHash } from 'node:crypto';

import { DescribeTasksCommand, RunTaskCommand, type Task } from '@aws-sdk/client-ecs';
import {
  sandboxTaskDefinitionOutputKey,
  type FixedTaskRequest,
  type TaskStatus,
} from '@movie-platform/experiment-sandbox';

import { ecs } from './aws-clients';
import { controlEnvironment } from './control-environment';
import {
  isWatchHealthy,
  launch,
  parseLaunchRequestFor,
  type LauncherPorts,
  type LaunchResult,
  type TaskObservation,
  type TaskRecipe,
} from './launcher';
import { readLeaseRow, readWatchRow, writeLeaseIfUnchanged } from './state-table';
import { readStableWorkloadOutputs } from './workload-observer';

/**
 * Lambda entry point the Harness delegate invokes with `{ experimentId, caseId, stepId }`
 * to start one trial step task; see `launcher.ts` for what the launcher is and why the
 * delegate cannot start tasks itself.
 *
 * Starts the step, or reports its status when it was already started. A running watch
 * step is reported as `PENDING` until its watcher is healthy, so the pipeline waits.
 *
 * @throws Error when the request is invalid or a launch rule refuses the step
 */
export async function launcherHandler(event: unknown): Promise<LaunchResult> {
  const request = parseLaunchRequestFor(event, controlEnvironment().experimentId);
  const result = await launch(request, awsLauncherPorts());

  if (request.stepId !== 'watch' || result.status !== 'RUNNING') {
    return result;
  }

  const watch = await readWatchRow(request.caseId);

  return isWatchHealthy(watch, Date.now()) ? result : { ...result, status: 'PENDING' };
}

/** The launcher's ports, backed by DynamoDB, ECS and the workload stack outputs. */
function awsLauncherPorts(): LauncherPorts {
  return {
    readLease: async () => {
      const lease = await readLeaseRow();

      if (!lease) {
        throw new Error('Lease not installed');
      }

      return lease;
    },
    compareAndSwap: writeLeaseIfUnchanged,
    observeTask: observeTrialTask,
    readWatch: readWatchRow,
    resolveTaskRecipe: async (request) => {
      const outputs = await readStableWorkloadOutputs();

      return taskRecipeFrom(
        outputs,
        sandboxTaskDefinitionOutputKey(request.caseId, request.stepId),
      );
    },
    runTask: startTrialTask,
    deriveClientToken: (reservationKey) =>
      createHash('sha256').update(reservationKey).digest('hex'),
    now: Date.now,
  };
}

async function observeTrialTask(taskArn: string): Promise<TaskObservation> {
  const response = await ecs.send(
    new DescribeTasksCommand({ cluster: controlEnvironment().clusterArn, tasks: [taskArn] }),
  );

  const task = response.tasks?.[0];

  if (!task?.taskDefinitionArn) {
    throw new Error('Task observation unavailable');
  }

  return { status: trialTaskStatus(task), taskDefinitionArn: task.taskDefinitionArn };
}

/**
 * A stopped trial task succeeded only if its single container exited with code 0;
 * any other stop (crash, OOM, StopTask) is a failure.
 */
function trialTaskStatus(task: Task): TaskStatus {
  if (task.lastStatus === 'RUNNING') {
    return 'RUNNING';
  }

  if (task.lastStatus !== 'STOPPED') {
    return 'PENDING';
  }

  const exitedCleanly =
    task.stopCode === 'EssentialContainerExited' &&
    task.containers?.length === 1 &&
    task.containers[0].exitCode === 0;

  return exitedCleanly ? 'SUCCEEDED' : 'FAILED';
}

/**
 * Builds the trusted part of a RunTask request from the workload stack's outputs, so
 * the caller can never choose the task definition, network or cluster.
 */
function taskRecipeFrom(
  outputs: Record<string, string>,
  taskDefinitionOutputKey: string,
): TaskRecipe {
  const taskDefinition = outputs[taskDefinitionOutputKey];

  const {
    SubnetIds: subnetIds,
    TaskSecurityGroupId: securityGroupId,
    ClusterArn: clusterArn,
  } = outputs;

  if (
    !taskDefinition ||
    !subnetIds ||
    !securityGroupId ||
    clusterArn !== controlEnvironment().clusterArn
  ) {
    throw new Error('Trusted workload recipe unavailable');
  }

  return {
    cluster: clusterArn,
    taskDefinition,
    count: 1,
    launchType: 'FARGATE',
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: subnetIds.split(','),
        securityGroups: [securityGroupId],
        assignPublicIp: 'ENABLED',
      },
    },
  };
}

async function startTrialTask(request: FixedTaskRequest): Promise<string> {
  const response = await ecs.send(
    new RunTaskCommand({
      ...request,
      tags: [{ key: 'ExperimentId', value: controlEnvironment().experimentId }],
    }),
  );

  const taskArn = response.tasks?.[0]?.taskArn;

  if (response.failures?.length || response.tasks?.length !== 1 || !taskArn) {
    throw new Error('Launch unresolved; retry the same step IDs');
  }

  return taskArn;
}
