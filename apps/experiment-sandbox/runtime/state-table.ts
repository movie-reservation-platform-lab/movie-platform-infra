/**
 * Reads and writes of the control state table. Every row read is validated: the table
 * is written by the operator, the launcher and the watch task, so a row is untrusted
 * input until its shape is checked.
 */

import {
  parseLeaseRow,
  parseWatchRow,
  type LeaseRow,
  type SandboxCaseId,
  type WatchRow,
} from '@movie-platform/experiment-sandbox';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { dynamo } from './aws-clients';
import { controlEnvironment } from './control-environment';

/**
 * Reads the experiment's lease row with a strongly consistent read.
 *
 * @returns undefined when the operator has not installed the lease yet
 * @throws Error when the row exists but has an invalid shape
 */
export async function readLeaseRow(): Promise<LeaseRow | undefined> {
  const { experimentId, stateTableName } = controlEnvironment();

  const response = await dynamo.send(
    new GetCommand({ TableName: stateTableName, Key: { experimentId }, ConsistentRead: true }),
  );

  return response.Item ? parseLeaseRow(response.Item) : undefined;
}

/**
 * Writes `lease` only if the stored version still equals `previousVersion` and the
 * lease is not disabled, so a concurrent writer or a cleanup that disabled the lease wins.
 *
 * @returns false when the condition failed; the caller re-reads and retries
 */
export async function writeLeaseIfUnchanged(
  previousVersion: number,
  lease: LeaseRow,
): Promise<boolean> {
  try {
    await dynamo.send(
      new PutCommand({
        TableName: controlEnvironment().stateTableName,
        Item: lease,
        ConditionExpression: '#version = :previousVersion AND disabled = :notDisabled',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':previousVersion': previousVersion, ':notDisabled': false },
      }),
    );

    return true;
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      return false;
    }

    throw error;
  }
}

/**
 * Disables the lease and bumps its version, so every in-flight launcher write fails its
 * condition and no new task starts. Idempotent.
 */
export async function disableLease(): Promise<void> {
  const { experimentId, stateTableName } = controlEnvironment();

  await dynamo.send(
    new UpdateCommand({
      TableName: stateTableName,
      Key: { experimentId },
      UpdateExpression: 'SET disabled = :disabled ADD #version :one',
      ExpressionAttributeNames: { '#version': 'version' },
      ExpressionAttributeValues: { ':disabled': true, ':one': 1 },
    }),
  );
}

/**
 * Reads the watch task's latest report for one case.
 *
 * @returns undefined while the watcher has not written a report
 * @throws Error when the row exists but has an invalid shape
 */
export async function readWatchRow(caseId: SandboxCaseId): Promise<WatchRow | undefined> {
  const { experimentId, stateTableName } = controlEnvironment();

  const response = await dynamo.send(
    new GetCommand({
      TableName: stateTableName,
      Key: { experimentId: `${experimentId}#${caseId}#watch` },
      ConsistentRead: true,
    }),
  );

  return response.Item ? parseWatchRow(response.Item) : undefined;
}
