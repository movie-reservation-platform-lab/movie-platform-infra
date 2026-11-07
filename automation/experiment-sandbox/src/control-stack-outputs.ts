/**
 * Reads the deployed control stack's outputs, the operator's only source for the
 * names and ARNs of the protected launcher, cleanup, schedule, alerts and state table.
 */

import type { ValidatedAwsAccess } from '@movie-platform/aws-account-preflight';
import type { SandboxRecord } from '@movie-platform/experiment-sandbox';

import { describeStacksResponseSchema, parseAwsResponse } from './aws-responses';
import type { AwsRunner } from './aws-runner';

/** Control stack states in which its outputs describe a finished deployment. */
const STABLE_STACK_STATUSES = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE']);

/**
 * The stack outputs of the record's control stack, keyed by output name.
 *
 * @throws Error when the record names no control stack, or it is missing or not stable
 */
export function readControlStackOutputs(
  run: AwsRunner,
  access: ValidatedAwsAccess,
  record: SandboxRecord,
): Map<string, string> {
  const stackName = record.inventory.controlStackName;

  if (!stackName) {
    throw new Error('Exact controlStackName required');
  }

  const { Stacks } = parseAwsResponse(
    describeStacksResponseSchema,
    run(access, ['cloudformation', 'describe-stacks', '--stack-name', stackName]),
    'describe-stacks',
  );

  if (Stacks.length !== 1) {
    throw new Error('Exact protected control stack required');
  }

  const [stack] = Stacks;

  if (!STABLE_STACK_STATUSES.has(stack.StackStatus) || !stack.Outputs) {
    throw new Error('Protected control stack must be stable');
  }

  return new Map(stack.Outputs.map((output) => [output.OutputKey, output.OutputValue]));
}

/**
 * Checks that the control stack protects the workload stack the record approved, so a
 * control stack of another deployment is never used.
 */
export function assertProtectsRecordedWorkload(
  outputs: ReadonlyMap<string, string>,
  record: SandboxRecord,
): void {
  if (outputs.get('WorkloadStackName') !== record.inventory.stackName) {
    throw new Error('Workload stack output mismatches approved inventory');
  }
}

/**
 * One required output.
 *
 * @throws Error naming the output when it is missing
 */
export function requiredOutput(outputs: ReadonlyMap<string, string>, key: string): string {
  const value = outputs.get(key);

  if (!value) {
    throw new Error(`Control stack output ${key} missing`);
  }

  return value;
}
