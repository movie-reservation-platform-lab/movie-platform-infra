/**
 * IAM for the trial steps in the workload stack. The gate step has no AWS
 * permissions; watch and release share a read-only view of the deployment, and
 * each adds only what its job needs. Kept apart from `workload-stack.ts` so every
 * permission can be reviewed in one file.
 */

import { SANDBOX_CASE_IDS, SANDBOX_PROBE_METRIC } from '@movie-platform/experiment-sandbox';
import { Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';

import { SandboxConfig, SandboxResourceNames } from './config';

/** Service principal ECS tasks assume their task roles with. */
export const ECS_TASKS_PRINCIPAL = 'ecs-tasks.amazonaws.com';

/** What the trial-step permission builders need to scope their policies. */
export interface TrialPermissionScope {
  /** The workload stack; ARNs are formatted for it. */
  readonly stack: Stack;
  readonly config: SandboxConfig;
  readonly names: SandboxResourceNames;
  readonly clusterArn: string;
  /** The control stack's state table, where the watch step records its verdict. */
  readonly stateTableArn: string;
  /** The deployment alarm the watch step feeds. */
  readonly probeAlarmArn: string;
}

/** Read-only view of the canary deployment, shared by the watch and release steps. */
export function grantDeploymentObserverAccess(role: iam.Role, scope: TrialPermissionScope): void {
  const { config, names } = scope;

  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ['ecs:DescribeServices', 'ecs:ListServiceDeployments'],
      resources: [serviceArn(scope.stack, names)],
    }),
  );

  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ['ecs:DescribeTasks'],
      resources: [taskArns(scope.stack, names)],
    }),
  );

  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ['ecs:ListTasks'],
      resources: ['*'],
      conditions: { ArnEquals: { 'ecs:cluster': scope.clusterArn } },
    }),
  );

  // AWS cannot limit ecs:DescribeTaskDefinition to specific task definitions: the
  // Service Authorization Reference lists no resource types for it, so a scoped
  // statement would be denied. It is read-only.
  role.addToPolicy(
    new iam.PolicyStatement({ actions: ['ecs:DescribeTaskDefinition'], resources: ['*'] }),
  );

  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ['cloudwatch:DescribeAlarms'],
      resources: [scope.probeAlarmArn],
    }),
  );

  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ['dynamodb:GetItem'],
      resources: [scope.stateTableArn],
      conditions: {
        'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': watchItemKeys(config) },
      },
    }),
  );
}

/** The watch step records its verdict and publishes the probe metric. */
export function grantWatchAccess(role: iam.Role, scope: TrialPermissionScope): void {
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ['dynamodb:UpdateItem'],
      resources: [scope.stateTableArn],
      conditions: {
        'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': watchItemKeys(scope.config) },
      },
    }),
  );

  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: { StringEquals: { 'cloudwatch:namespace': SANDBOX_PROBE_METRIC.namespace } },
    }),
  );
}

/**
 * The release step registers a new recipe revision and points the service at it.
 *
 * @param passableRoles - the recipe's task and execution roles, which a new revision reuses
 */
export function grantReleaseAccess(
  role: iam.Role,
  scope: TrialPermissionScope,
  passableRoles: readonly iam.IRole[],
): void {
  const { config, names } = scope;

  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ['ecs:RegisterTaskDefinition'],
      resources: ['*'],
      conditions: { StringEquals: { 'aws:RequestTag/ExperimentId': config.experimentId } },
    }),
  );

  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ['ecs:TagResource'],
      resources: [recipeTaskDefinitionArns(scope.stack, names)],
    }),
  );

  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ['ecs:UpdateService'],
      resources: [serviceArn(scope.stack, names)],
      conditions: { ArnEquals: { 'ecs:cluster': scope.clusterArn } },
    }),
  );

  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: passableRoles.map((passable) => passable.roleArn),
      conditions: { StringEquals: { 'iam:PassedToService': ECS_TASKS_PRINCIPAL } },
    }),
  );
}

/** DynamoDB partition keys of the per-case watch records. */
function watchItemKeys(config: SandboxConfig): string[] {
  return SANDBOX_CASE_IDS.map((caseId) => `${config.experimentId}#${caseId}#watch`);
}

/** The recommendation service. */
function serviceArn(stack: Stack, names: SandboxResourceNames): string {
  return stack.formatArn({
    service: 'ecs',
    resource: 'service',
    resourceName: `${names.cluster}/${names.recommendationService}`,
  });
}

/** Every task in the workload cluster. */
function taskArns(stack: Stack, names: SandboxResourceNames): string {
  return stack.formatArn({
    service: 'ecs',
    resource: 'task',
    resourceName: `${names.cluster}/*`,
  });
}

/** Every revision of the recommendation recipe family. */
function recipeTaskDefinitionArns(stack: Stack, names: SandboxResourceNames): string {
  return stack.formatArn({
    service: 'ecs',
    resource: 'task-definition',
    resourceName: `${names.recommendationTaskFamily}:*`,
  });
}
