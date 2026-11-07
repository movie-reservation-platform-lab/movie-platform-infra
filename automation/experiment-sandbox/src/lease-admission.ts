/**
 * Installs the experiment's lease row, the switch that lets the workload deploy and
 * trial tasks start. Before writing it, the operator checks the deployed safeguards
 * that end the lease: the enabled expiry schedule and a confirmed alert subscription.
 */

import type { ValidatedAwsAccess } from '@movie-platform/aws-account-preflight';
import {
  newLeaseRow,
  scheduledCleanupRequest,
  type LeaseRow,
  type SandboxRecord,
} from '@movie-platform/experiment-sandbox';

import {
  describeRuleResponseSchema,
  listSubscriptionsResponseSchema,
  listTargetsResponseSchema,
  parseAwsResponse,
} from './aws-responses';
import type { AwsRunner } from './aws-runner';
import {
  assertProtectsRecordedWorkload,
  readControlStackOutputs,
  requiredOutput,
} from './control-stack-outputs';

/** A confirmed SNS subscription has an ARN; a pending one reads `PendingConfirmation`. */
const CONFIRMED_SUBSCRIPTION_PREFIX = 'arn:aws:sns:';

/**
 * Checks the cleanup safeguards, then writes the lease row once. The write is
 * conditional, so repeating `admit` can never reset the launch counters.
 *
 * @throws Error when a safeguard is missing or the lease already exists
 */
export function installLease(
  run: AwsRunner,
  access: ValidatedAwsAccess,
  record: SandboxRecord,
): void {
  const outputs = readControlStackOutputs(run, access, record);

  assertProtectsRecordedWorkload(outputs, record);

  if (outputs.get('ExperimentId') !== record.id) {
    throw new Error('Control stack experiment ID mismatches record');
  }

  assertCleanupScheduled(run, access, record, outputs);
  assertAlertSubscribed(run, access, outputs);

  const stateTable = requiredOutput(outputs, 'StateTableName');
  const lease = newLeaseRow(record.id, record.lease);

  run(access, [
    'dynamodb',
    'put-item',
    '--table-name',
    stateTable,
    '--item',
    JSON.stringify(toDynamoItem(lease)),
    '--condition-expression',
    'attribute_not_exists(experimentId)',
  ]);
}

/** The expiry schedule is enabled and targets the protected cleanup with the exact input. */
function assertCleanupScheduled(
  run: AwsRunner,
  access: ValidatedAwsAccess,
  record: SandboxRecord,
  outputs: ReadonlyMap<string, string>,
): void {
  const rule = requiredOutput(outputs, 'CleanupScheduleName');
  const cleanupArn = requiredOutput(outputs, 'CleanupArn');

  const schedule = parseAwsResponse(
    describeRuleResponseSchema,
    run(access, ['events', 'describe-rule', '--name', rule]),
    'describe-rule',
  );

  if (schedule.State !== 'ENABLED') {
    throw new Error('Independent cleanup schedule must be enabled');
  }

  const { Targets } = parseAwsResponse(
    listTargetsResponseSchema,
    run(access, ['events', 'list-targets-by-rule', '--rule', rule]),
    'list-targets-by-rule',
  );

  const expectedInput = JSON.stringify(scheduledCleanupRequest(record.id));

  if (!Targets.some((target) => target.Arn === cleanupArn && target.Input === expectedInput)) {
    throw new Error('Independent cleanup schedule target mismatches protected function/input');
  }
}

/** Someone receives cleanup alerts: the alert topic has at least one confirmed subscription. */
function assertAlertSubscribed(
  run: AwsRunner,
  access: ValidatedAwsAccess,
  outputs: ReadonlyMap<string, string>,
): void {
  const topic = requiredOutput(outputs, 'CleanupAlertTopicArn');

  const { Subscriptions } = parseAwsResponse(
    listSubscriptionsResponseSchema,
    run(access, ['sns', 'list-subscriptions-by-topic', '--topic-arn', topic]),
    'list-subscriptions-by-topic',
  );

  const confirmed = Subscriptions.some((subscription) =>
    subscription.SubscriptionArn.startsWith(CONFIRMED_SUBSCRIPTION_PREFIX),
  );

  if (!confirmed) {
    throw new Error('Confirmed trusted cleanup alert subscription required');
  }
}

/** The lease row in the AWS CLI's typed attribute-value format. */
function toDynamoItem(lease: LeaseRow): Record<string, unknown> {
  return {
    experimentId: { S: lease.experimentId },
    version: { N: String(lease.version) },
    expiresAt: { S: lease.expiresAt },
    rejectNewWorkAt: { S: lease.rejectNewWorkAt },
    disabled: { BOOL: lease.disabled },
    total: { N: String(lease.total) },
    requests: { M: {} },
  };
}
