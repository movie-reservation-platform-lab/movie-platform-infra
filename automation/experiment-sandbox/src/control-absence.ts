/**
 * Checks whether one captured control resource is gone. Only a "not found" answer from
 * AWS counts as absence; access denied or any other error is reported, never assumed.
 */

import type { ValidatedAwsAccess } from '@movie-platform/aws-account-preflight';
import type { RetiredControlResource } from '@movie-platform/experiment-sandbox';

import { AwsOperationError } from './aws-error';
import { describeTableResponseSchema, logGroupPageSchema, parseAwsResponse } from './aws-responses';
import { nextTokenArgs, readAllPages, type AwsRunner } from './aws-runner';

/**
 * Checks whether a captured control resource is absent from the sandbox account.
 *
 * @param run - AWS CLI runner used to inspect the resource
 * @param access - validated AWS profile, region and configuration files
 * @param resource - captured resource identity to check
 * @param accountId - expected sandbox account owner for S3 requests
 * @returns true when absence is confirmed; false when the matching resource exists
 * @throws Error when inspection fails, identity mismatches, or a listing is incomplete
 */
export function isControlResourceAbsent(
  run: AwsRunner,
  access: ValidatedAwsAccess,
  resource: RetiredControlResource,
  accountId: string,
): boolean {
  switch (resource.resourceClass) {
    case 'AWS::DynamoDB::Table':
      return isTableAbsent(run, access, resource);
    case 'AWS::S3::Bucket':
      return isBucketAbsent(run, access, resource, accountId);
    case 'AWS::Logs::LogGroup':
      return isLogGroupAbsent(run, access, resource);
  }
}

function isTableAbsent(
  run: AwsRunner,
  access: ValidatedAwsAccess,
  resource: RetiredControlResource,
): boolean {
  let response: unknown;

  try {
    response = run(access, ['dynamodb', 'describe-table', '--table-name', resource.physicalId]);
  } catch (error) {
    if (isNotFound(error, ['ResourceNotFoundException'])) {
      return true;
    }

    throw error;
  }

  const { Table } = parseAwsResponse(describeTableResponseSchema, response, 'describe-table');

  if (Table.TableArn !== resource.arn) {
    throw new Error('Control table identity mismatch');
  }

  return false;
}

function isBucketAbsent(
  run: AwsRunner,
  access: ValidatedAwsAccess,
  resource: RetiredControlResource,
  accountId: string,
): boolean {
  try {
    run(access, [
      's3api',
      'head-bucket',
      '--bucket',
      resource.physicalId,
      '--expected-bucket-owner',
      accountId,
    ]);

    return false;
  } catch (error) {
    if (isNotFound(error, ['404', 'NoSuchBucket'])) {
      return true;
    }

    throw error;
  }
}

function isLogGroupAbsent(
  run: AwsRunner,
  access: ValidatedAwsAccess,
  resource: RetiredControlResource,
): boolean {
  const pages = readAllPages(
    (nextToken) =>
      parseAwsResponse(
        logGroupPageSchema,
        run(access, [
          'logs',
          'describe-log-groups',
          '--log-group-name-prefix',
          resource.physicalId,
          '--no-paginate',
          ...nextTokenArgs(nextToken),
        ]),
        'describe-log-groups',
      ),
    (page) => page.nextToken || undefined,
    'Control log absence could not be established within ten pages',
  );

  return !pages.some((page) =>
    page.logGroups.some((group) => group.logGroupName === resource.physicalId),
  );
}

function isNotFound(error: unknown, notFoundCodes: readonly string[]): boolean {
  return (
    error instanceof AwsOperationError &&
    error.code !== undefined &&
    notFoundCodes.includes(error.code)
  );
}
