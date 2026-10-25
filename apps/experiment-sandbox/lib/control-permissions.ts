// IAM for the control stack: the role CloudFormation uses to delete the
// workload stack, and the permissions of the launcher and cleanup Lambdas.
// Kept apart from `control-stack.ts` so the stack reads as a list of
// resources, and every permission can be reviewed in one file.

import { ArnFormat, Stack, Tags } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';

import {
  SANDBOX_CASE_IDS,
  SANDBOX_STEP_IDS,
  sandboxTaskFamily,
} from '@movie-platform/experiment-sandbox';

import { SandboxConfig, SandboxResourceNames } from './config';

/** What every permission builder needs to know about the stack it writes into. */
export interface ControlPermissionScope {
  /** The control stack; constructs are created in it and ARNs are formatted for it. */
  readonly stack: Stack;
  readonly config: SandboxConfig;
  readonly names: SandboxResourceNames;
  /** ARN of the workload stack's ECS cluster. */
  readonly clusterArn: string;
  /** ARN pattern matching every deployment of the workload stack. */
  readonly workloadStackArn: string;
}

/**
 * CloudFormation service role used only to delete the workload stack.
 *
 * It can remove this experiment's resources but cannot create anything or touch the
 * protected control IAM roles or state.
 */
export function createWorkloadDeletionRole(scope: ControlPermissionScope): iam.Role {
  const { stack, config, names, clusterArn } = scope;

  const role = new iam.Role(stack, 'WorkloadDeletionRole', {
    assumedBy: new iam.ServicePrincipal('cloudformation.amazonaws.com'),
    roleName: `${config.experimentId}-workload-deletion`,
  });

  role.addToPolicy(
    new iam.PolicyStatement({
      actions: [
        'ecs:DeleteService',
        'ecs:UpdateService',
        'ecs:DeleteCluster',
        'ecs:DeleteTaskDefinitions',
        'ecs:TagResource',
        'ecs:UntagResource',
      ],
      resources: [
        clusterArn,
        stack.formatArn({
          service: 'ecs',
          resource: 'service',
          resourceName: `${names.cluster}/*`,
        }),
        experimentTaskDefinitionArns(scope),
      ],
    }),
  );

  // AWS cannot limit ecs:DeregisterTaskDefinition to specific task definitions: the
  // Service Authorization Reference lists no resource types for it, so a scoped
  // statement would be denied. The dedicated sandbox account is the boundary.
  role.addToPolicy(
    new iam.PolicyStatement({ actions: ['ecs:DeregisterTaskDefinition'], resources: ['*'] }),
  );

  role.addToPolicy(
    new iam.PolicyStatement({
      actions: [
        'ecs:DescribeServices',
        'ecs:DescribeClusters',
        'ecs:DescribeTaskDefinition',
        'ec2:Describe*',
        'elasticloadbalancing:Describe*',
        'cloudwatch:DescribeAlarms',
      ],
      resources: ['*'],
    }),
  );

  role.addToPolicy(
    new iam.PolicyStatement({
      actions: [
        'elasticloadbalancing:DeleteLoadBalancer',
        'elasticloadbalancing:DeleteListener',
        'elasticloadbalancing:DeleteRule',
        'elasticloadbalancing:DeleteTargetGroup',
        'elasticloadbalancing:RemoveTags',
      ],
      resources: [
        stack.formatArn({
          service: 'elasticloadbalancing',
          resource: 'loadbalancer',
          resourceName: `app/${config.experimentId}-*/*`,
        }),
        stack.formatArn({
          service: 'elasticloadbalancing',
          resource: 'listener',
          resourceName: `app/${config.experimentId}-*/*/*`,
        }),
        stack.formatArn({
          service: 'elasticloadbalancing',
          resource: 'listener-rule',
          resourceName: `app/${config.experimentId}-*/*/*/*`,
        }),
        stack.formatArn({
          service: 'elasticloadbalancing',
          resource: 'targetgroup',
          resourceName: `${config.experimentId}-*/*`,
        }),
      ],
    }),
  );

  // Some route/association teardown APIs cannot authorize resource tags. Only this fixed-stack
  // CloudFormation deletion path may assume the role; control contains no EC2 resources.
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: [
        'ec2:DeleteVpc',
        'ec2:DeleteSubnet',
        'ec2:DeleteRouteTable',
        'ec2:DeleteRoute',
        'ec2:DisassociateRouteTable',
        'ec2:DeleteSecurityGroup',
        'ec2:RevokeSecurityGroupIngress',
        'ec2:RevokeSecurityGroupEgress',
        'ec2:DetachInternetGateway',
        'ec2:DeleteInternetGateway',
      ],
      resources: ['*'],
      conditions: { StringEquals: { 'aws:RequestedRegion': config.region } },
    }),
  );

  // Workload roles share the experiment prefix with control roles, so the
  // ProtectedControl tag is what keeps control roles out of reach.
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: [
        'iam:DeleteRole',
        'iam:DeleteRolePolicy',
        'iam:DetachRolePolicy',
        'iam:GetRole',
        'iam:ListRolePolicies',
        'iam:ListAttachedRolePolicies',
      ],
      resources: [
        stack.formatArn({
          service: 'iam',
          region: '',
          resource: 'role',
          resourceName: `${config.experimentId}-*`,
        }),
      ],
      conditions: { StringNotEquals: { 'iam:ResourceTag/ProtectedControl': 'true' } },
    }),
  );

  // CloudWatch Logs discovery does not support resource-level permissions.
  role.addToPolicy(
    new iam.PolicyStatement({ actions: ['logs:DescribeLogGroups'], resources: ['*'] }),
  );

  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ['logs:DeleteLogGroup'],
      resources: [
        stack.formatArn({
          service: 'logs',
          resource: 'log-group',
          resourceName: `/experiment/${config.experimentId}/*`,
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
        }),
      ],
    }),
  );

  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ['cloudwatch:DeleteAlarms'],
      resources: [
        stack.formatArn({
          service: 'cloudwatch',
          resource: 'alarm',
          resourceName: `${config.experimentId}-probe`,
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
        }),
      ],
    }),
  );

  Tags.of(role).add('ProtectedControl', 'true');

  return role;
}

/** The launcher starts trial tasks in the workload cluster with the trial roles. */
export function grantLauncherAccess(
  scope: ControlPermissionScope,
  launcher: lambda.IFunction,
  state: dynamodb.ITable,
): void {
  const { stack, names, clusterArn, workloadStackArn } = scope;

  state.grantReadWriteData(launcher);

  launcher.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['cloudformation:DescribeStacks'],
      resources: [workloadStackArn],
    }),
  );

  launcher.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['ecs:RunTask'],
      resources: trialTaskDefinitionArns(scope),
      conditions: { ArnEquals: { 'ecs:cluster': clusterArn } },
    }),
  );

  launcher.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['ecs:TagResource'],
      resources: [workloadTaskArns(scope)],
      conditions: { StringEquals: { 'ecs:CreateAction': 'RunTask' } },
    }),
  );

  launcher.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['ecs:DescribeTasks'],
      resources: [workloadTaskArns(scope)],
      conditions: { ArnEquals: { 'ecs:cluster': clusterArn } },
    }),
  );

  // These roles are created by the workload stack. Their names come from the
  // same sandboxResourceNames() helper, so both stacks agree.
  const passableRoleNames = [
    names.roles.gate,
    names.roles.watch,
    names.roles.release,
    names.roles.execution,
  ];

  launcher.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: passableRoleNames.map((roleName) =>
        stack.formatArn({ service: 'iam', region: '', resource: 'role', resourceName: roleName }),
      ),
      conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
    }),
  );
}

/** Cleanup stops trial tasks, deregisters task definitions, and deletes the workload stack. */
export function grantCleanupAccess(
  scope: ControlPermissionScope,
  cleanup: lambda.IFunction,
  storage: { readonly state: dynamodb.ITable; readonly inventory: s3.IBucket },
  deletionRole: iam.IRole,
): void {
  const { clusterArn, workloadStackArn } = scope;

  storage.state.grantReadWriteData(cleanup);
  storage.inventory.grantReadWrite(cleanup);

  cleanup.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        'cloudformation:DescribeStacks',
        'cloudformation:ListStackResources',
        'cloudformation:DeleteStack',
        'cloudformation:CancelUpdateStack',
      ],
      resources: [workloadStackArn],
    }),
  );

  cleanup.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [deletionRole.roleArn],
      conditions: { StringEquals: { 'iam:PassedToService': 'cloudformation.amazonaws.com' } },
    }),
  );

  cleanup.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['ecs:ListTasks'],
      resources: ['*'],
      conditions: { ArnEquals: { 'ecs:cluster': clusterArn } },
    }),
  );

  cleanup.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['ecs:StopTask'],
      resources: [workloadTaskArns(scope)],
    }),
  );

  cleanup.addToRolePolicy(
    new iam.PolicyStatement({ actions: ['ecs:ListTaskDefinitions'], resources: ['*'] }),
  );

  // AWS cannot limit ecs:DeregisterTaskDefinition to specific task definitions: the
  // Service Authorization Reference lists no resource types for it, so a scoped
  // statement would be denied. The dedicated sandbox account is the boundary.
  cleanup.addToRolePolicy(
    new iam.PolicyStatement({ actions: ['ecs:DeregisterTaskDefinition'], resources: ['*'] }),
  );

  cleanup.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['ecs:DeleteTaskDefinitions'],
      resources: [experimentTaskDefinitionArns(scope)],
    }),
  );
}

/** Every task definition family with the experiment prefix, all revisions. */
function experimentTaskDefinitionArns(scope: ControlPermissionScope): string {
  return scope.stack.formatArn({
    service: 'ecs',
    resource: 'task-definition',
    resourceName: `${scope.config.experimentId}-*:*`,
  });
}

/**
 * The nine trial step task definitions (three cases times three steps), all revisions.
 *
 * Narrower than {@link experimentTaskDefinitionArns}: the launcher may not start the
 * recommendation service or the delegate as standalone tasks.
 */
function trialTaskDefinitionArns(scope: ControlPermissionScope): string[] {
  return SANDBOX_CASE_IDS.flatMap((caseId) =>
    SANDBOX_STEP_IDS.map((stepId) =>
      scope.stack.formatArn({
        service: 'ecs',
        resource: 'task-definition',
        resourceName: `${sandboxTaskFamily(scope.config.experimentId, caseId, stepId)}:*`,
      }),
    ),
  );
}

/** Every task, standalone or service-owned, in the workload cluster. */
function workloadTaskArns(scope: ControlPermissionScope): string {
  return scope.stack.formatArn({
    service: 'ecs',
    resource: 'task',
    resourceName: `${scope.names.cluster}/*`,
  });
}
