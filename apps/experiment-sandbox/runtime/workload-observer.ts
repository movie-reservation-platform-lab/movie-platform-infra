/**
 * Read-only views of the workload stack, its tasks and its task definitions, shared by
 * the launcher (which needs stable outputs) and cleanup (which needs everything left).
 */

import {
  sandboxRecommendationTaskFamily,
  sandboxTaskFamilies,
} from '@movie-platform/experiment-sandbox';
import {
  DescribeStacksCommand,
  ListStackResourcesCommand,
  type Stack,
} from '@aws-sdk/client-cloudformation';
import {
  DescribeTasksCommand,
  ListTaskDefinitionsCommand,
  ListTasksCommand,
  type TaskDefinitionStatus,
} from '@aws-sdk/client-ecs';

import { cloudFormation, ecs } from './aws-clients';
import { controlEnvironment } from './control-environment';
import type { ClusterTask } from './run-limit';

/** Stack states in which the outputs describe a finished, usable deployment. */
const STABLE_STACK_STATUSES = new Set([
  'CREATE_COMPLETE',
  'UPDATE_COMPLETE',
  'UPDATE_ROLLBACK_COMPLETE',
]);

/**
 * Describes the workload stack.
 *
 * @returns undefined when the stack does not exist (never created, or fully deleted)
 */
export async function describeWorkloadStack(): Promise<Stack | undefined> {
  try {
    const response = await cloudFormation.send(
      new DescribeStacksCommand({ StackName: controlEnvironment().workloadStackName }),
    );

    return response.Stacks?.[0];
  } catch (error) {
    const stackIsMissing =
      error instanceof Error &&
      error.name === 'ValidationError' &&
      error.message.includes('does not exist');

    if (stackIsMissing) {
      return undefined;
    }

    throw error;
  }
}

/**
 * The workload stack's outputs, keyed by output name.
 *
 * @throws Error when the stack is missing or not in a stable state
 */
export async function readStableWorkloadOutputs(): Promise<Record<string, string>> {
  const stack = await describeWorkloadStack();

  if (!stack || !STABLE_STACK_STATUSES.has(stack.StackStatus ?? '')) {
    throw new Error('Workload is not stable');
  }

  const outputs: Record<string, string> = {};

  for (const output of stack.Outputs ?? []) {
    if (output.OutputKey && output.OutputValue) {
      outputs[output.OutputKey] = output.OutputValue;
    }
  }

  return outputs;
}

/** Physical IDs of every workload stack resource not yet deleted. */
export async function listStackResourceIds(): Promise<string[]> {
  const ids: string[] = [];
  let nextToken: string | undefined;

  do {
    const response = await cloudFormation.send(
      new ListStackResourcesCommand({
        StackName: controlEnvironment().workloadStackName,
        NextToken: nextToken,
      }),
    );

    for (const resource of response.StackResourceSummaries ?? []) {
      if (resource.ResourceStatus !== 'DELETE_COMPLETE' && resource.PhysicalResourceId) {
        ids.push(resource.PhysicalResourceId);
      }
    }

    nextToken = response.NextToken;
  } while (nextToken);

  return ids;
}

/** ARNs of every task in the workload cluster; none once the cluster is gone. */
export async function listWorkloadTaskArns(): Promise<string[]> {
  const taskArns: string[] = [];
  let nextToken: string | undefined;

  do {
    try {
      const response = await ecs.send(
        new ListTasksCommand({ cluster: controlEnvironment().clusterArn, nextToken }),
      );

      taskArns.push(...(response.taskArns ?? []));
      nextToken = response.nextToken;
    } catch (error) {
      // A deleted cluster cannot hold tasks, so "no cluster" means "no tasks".
      if (error instanceof Error && error.name === 'ClusterNotFoundException') {
        return [];
      }

      throw error;
    }
  } while (nextToken);

  return taskArns;
}

/** ECS describes at most 100 tasks per DescribeTasks call. */
const DESCRIBE_TASKS_BATCH_SIZE = 100;

/** Group and start times of the given tasks in the workload cluster. */
export async function describeWorkloadTasks(taskArns: readonly string[]): Promise<ClusterTask[]> {
  const tasks: ClusterTask[] = [];

  for (let offset = 0; offset < taskArns.length; offset += DESCRIBE_TASKS_BATCH_SIZE) {
    const response = await ecs.send(
      new DescribeTasksCommand({
        cluster: controlEnvironment().clusterArn,
        tasks: taskArns.slice(offset, offset + DESCRIBE_TASKS_BATCH_SIZE),
      }),
    );

    for (const task of response.tasks ?? []) {
      if (task.taskArn) {
        tasks.push({
          taskArn: task.taskArn,
          group: task.group,
          startedAt: task.startedAt,
          createdAt: task.createdAt,
        });
      }
    }
  }

  return tasks;
}

/**
 * Task definition ARNs of this experiment's families in the given states.
 *
 * @param onlyReleaseRevisions - only recommendation revisions; while the stack exists,
 *   those are the ones the release step registered outside CloudFormation
 */
export async function listExperimentTaskDefinitions(
  statuses: readonly TaskDefinitionStatus[],
  onlyReleaseRevisions = false,
): Promise<string[]> {
  const { experimentId } = controlEnvironment();
  const allowedFamilies = new Set(sandboxTaskFamilies(experimentId));
  const recommendationFamily = sandboxRecommendationTaskFamily(experimentId);
  const arns = new Set<string>();

  for (const status of statuses) {
    let nextToken: string | undefined;

    do {
      const response = await ecs.send(
        new ListTaskDefinitionsCommand({ familyPrefix: `${experimentId}-`, nextToken, status }),
      );

      for (const arn of response.taskDefinitionArns ?? []) {
        const family = taskDefinitionFamily(arn);
        const wanted = !onlyReleaseRevisions || family === recommendationFamily;

        if (family && allowedFamilies.has(family) && wanted) {
          arns.add(arn);
        }
      }

      nextToken = response.nextToken;
    } while (nextToken);
  }

  return [...arns];
}

/** The family part of `arn:aws:ecs:<region>:<account>:task-definition/<family>:<revision>`. */
function taskDefinitionFamily(arn: string): string | undefined {
  return arn.split('/')[1]?.split(':')[0];
}
