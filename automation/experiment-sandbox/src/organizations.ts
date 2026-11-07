/**
 * AWS Organizations calls for the sandbox account's life: create, look up a creation
 * request, close, and read closure state. All run with the management account's profile.
 */

import type { ValidatedAwsAccess } from '@movie-platform/aws-account-preflight';
import type { SandboxRecord } from '@movie-platform/experiment-sandbox';
import type { z } from 'zod';

import { AwsOperationError } from './aws-error';
import {
  createAccountResponseSchema,
  createAccountStatusPageSchema,
  createAccountStatusSchema,
  describeAccountResponseSchema,
  parseAwsResponse,
} from './aws-responses';
import { nextTokenArgs, readAllPages, type AwsRunner } from './aws-runner';
import type { AccountResult } from './lifecycle';
import { RequestNotSubmittedError } from './lifecycle';
import { sandboxAccountId } from './operator-access';

const CREATE_ACCOUNT_REQUEST_ID = /^car-[a-z0-9-]+$/;
const AWS_ACCOUNT_ID = /^\d{12}$/;

/** Creation requests listed per page while reconciling a lost response. */
const CREATE_STATUS_PAGE_SIZE = '20';

/**
 * `CreateAccount` error codes that mean AWS rejected the request outright, so no account
 * exists. `ServiceException` is missing on purpose: an internal error may still have
 * created the account.
 */
const CREATE_ACCOUNT_REJECTIONS = new Set([
  'AccessDeniedException',
  'AWSOrganizationsNotInUseException',
  'ConcurrentModificationException',
  'ConstraintViolationException',
  'FinalizingOrganizationException',
  'InvalidInputException',
  'TooManyRequestsException',
  'UnsupportedAPIEndpointException',
]);

type CreateAccountStatus = z.output<typeof createAccountStatusSchema>;

/**
 * Checks that the account name can be matched to its request later: it must end with
 * the record's unique correlation ID, because a lost response is found by name.
 */
export function assertCorrelatedAccountName(record: SandboxRecord): void {
  if (!record.account.name.endsWith(record.account.correlationId)) {
    throw new Error('Account name must end with unique creation correlationId');
  }
}

/**
 * Requests a new member account, with billing access for IAM users denied.
 *
 * @throws RequestNotSubmittedError when AWS explicitly rejected the request
 */
export function requestAccount(
  run: AwsRunner,
  access: ValidatedAwsAccess,
  record: SandboxRecord,
): AccountResult {
  let response: unknown;

  try {
    response = run(access, [
      'organizations',
      'create-account',
      '--email',
      record.account.email,
      '--account-name',
      record.account.name,
      '--iam-user-access-to-billing',
      'DENY',
      '--tags',
      `Key=ExperimentId,Value=${record.id}`,
      `Key=ExperimentCorrelation,Value=${record.account.correlationId}`,
    ]);
  } catch (error) {
    if (
      error instanceof AwsOperationError &&
      error.code &&
      CREATE_ACCOUNT_REJECTIONS.has(error.code)
    ) {
      throw new RequestNotSubmittedError(`AWS rejected account creation with ${error.code}`, {
        cause: error,
      });
    }

    throw error;
  }

  const { CreateAccountStatus } = parseAwsResponse(
    createAccountResponseSchema,
    response,
    'create-account',
  );

  return accountResultOf(CreateAccountStatus, record);
}

/**
 * Finds the record's creation request: by request ID when known, otherwise by its
 * unique account name among recent requests.
 *
 * @throws Error when the request is missing, ambiguous, or beyond the page limit
 */
export function findAccountRequest(
  run: AwsRunner,
  access: ValidatedAwsAccess,
  record: SandboxRecord,
): AccountResult {
  if (record.account.requestId) {
    const response = run(access, [
      'organizations',
      'describe-create-account-status',
      '--create-account-request-id',
      record.account.requestId,
    ]);

    const { CreateAccountStatus } = parseAwsResponse(
      createAccountResponseSchema,
      response,
      'describe-create-account-status',
    );

    return accountResultOf(CreateAccountStatus, record);
  }

  const pages = readAllPages(
    (nextToken) =>
      parseAwsResponse(
        createAccountStatusPageSchema,
        run(access, [
          'organizations',
          'list-create-account-status',
          '--no-paginate',
          '--max-results',
          CREATE_STATUS_PAGE_SIZE,
          ...nextTokenArgs(nextToken),
        ]),
        'list-create-account-status',
      ),
    (page) => page.NextToken || undefined,
    'Account reconciliation exceeded ten pages; trusted operator recovery required',
  );

  const matches = pages
    .flatMap((page) => page.CreateAccountStatuses)
    .filter((entry) => entry.AccountName === record.account.name);

  if (matches.length !== 1) {
    throw new Error(
      'Creation state ambiguous or absent; reconcile unique account correlation before any new create',
    );
  }

  const status = parseAwsResponse(
    createAccountStatusSchema,
    matches[0],
    'list-create-account-status',
  );

  return accountResultOf(status, record);
}

/** Requests closure of the sandbox account; AWS closes it asynchronously. */
export function requestAccountClosure(
  run: AwsRunner,
  access: ValidatedAwsAccess,
  record: SandboxRecord,
): void {
  run(access, ['organizations', 'close-account', '--account-id', sandboxAccountId(record)]);
}

/**
 * Reads whether a closure request was accepted or finished.
 *
 * @throws Error when the account is in any other state; the closure intent must stay
 */
export function readClosureState(
  run: AwsRunner,
  access: ValidatedAwsAccess,
  record: SandboxRecord,
): 'closure-requested' | 'closed' {
  const accountId = sandboxAccountId(record);

  const { Account } = parseAwsResponse(
    describeAccountResponseSchema,
    run(access, ['organizations', 'describe-account', '--account-id', accountId]),
    'describe-account',
  );

  if (Account.Id !== accountId) {
    throw new Error('Wrong retirement account response');
  }

  if (Account.State === 'CLOSED') {
    return 'closed';
  }

  if (Account.State === 'PENDING_CLOSURE') {
    return 'closure-requested';
  }

  throw new Error(
    'Account closure not confirmed; preserve closure intent and inspect trusted Organizations account state',
  );
}

/**
 * Maps a creation request to the record's account state, after checking that it is the
 * record's own request and, once known, its own account.
 */
function accountResultOf(status: CreateAccountStatus, record: SandboxRecord): AccountResult {
  if (!CREATE_ACCOUNT_REQUEST_ID.test(status.Id)) {
    throw new Error('Malformed account request ID');
  }

  const isOwnRequest =
    status.AccountName === record.account.name &&
    (!record.account.requestId || status.Id === record.account.requestId) &&
    (!record.account.accountId || status.AccountId === record.account.accountId);

  if (!isOwnRequest) {
    throw new Error('Account request correlation or established identity mismatch');
  }

  if (status.State === 'IN_PROGRESS') {
    return { state: 'requested', requestId: status.Id };
  }

  if (status.State === 'FAILED') {
    return { state: 'failed', requestId: status.Id };
  }

  if (!status.AccountId || !AWS_ACCOUNT_ID.test(status.AccountId)) {
    throw new Error('Malformed account ID');
  }

  return { state: 'ready', requestId: status.Id, accountId: status.AccountId };
}
