/**
 * Runs the AWS CLI as a subprocess for the operator. Every call uses an argument array
 * (no shell), the validated SSO profile and region, a time limit and an output limit.
 */

import { spawnSync } from 'node:child_process';

import type { ValidatedAwsAccess } from '@movie-platform/aws-account-preflight';

import { AwsOperationError } from './aws-error';

/** Longest one AWS CLI call may run. */
const AWS_CLI_TIMEOUT_MS = 60_000;

/** Largest AWS CLI output accepted, in bytes. */
const AWS_CLI_MAX_OUTPUT_BYTES = 1024 * 1024;

/** Where the AWS CLI puts the service error code in its stderr message. */
const AWS_ERROR_CODE = /An error occurred \(([^)]+)\) when calling/;

/** Most result pages read from one listing; beyond this the operator cannot prove completeness. */
export const MAX_PAGES = 10;

/**
 * Runs one AWS CLI command and returns its parsed JSON output, or `{}` when it prints
 * nothing. Tests pass a fake with the same signature.
 *
 * @throws AwsOperationError when the command fails or times out
 */
export type AwsRunner = (access: ValidatedAwsAccess, args: readonly string[]) => unknown;

/** The real {@link AwsRunner}: spawns `aws` with the validated profile's config files. */
export const runAws: AwsRunner = (access, args) => {
  const result = spawnSync(
    'aws',
    [
      ...args,
      '--profile',
      access.target.profile,
      '--region',
      access.target.region,
      '--output',
      'json',
      '--no-cli-pager',
    ],
    {
      encoding: 'utf8',
      timeout: AWS_CLI_TIMEOUT_MS,
      maxBuffer: AWS_CLI_MAX_OUTPUT_BYTES,
      shell: false,
      env: {
        ...process.env,
        AWS_CONFIG_FILE: access.configFiles.configFilepath,
        AWS_SHARED_CREDENTIALS_FILE: access.configFiles.credentialsFilepath,
      },
    },
  );

  if (result.error || result.status !== 0) {
    throw new AwsOperationError(result.stderr?.match(AWS_ERROR_CODE)?.[1]);
  }

  if (!result.stdout.trim()) {
    return {};
  }

  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error('AWS CLI returned invalid JSON');
  }
};

/**
 * Reads a paginated listing page by page, at most {@link MAX_PAGES} pages.
 *
 * @param fetchPage - reads one page; receives the previous page's token, or undefined first
 * @param nextTokenOf - the token for the next page, or undefined on the last page
 * @param limitMessage - error text when more than {@link MAX_PAGES} pages exist
 * @throws Error with `limitMessage` when the listing has more pages than the limit
 */
export function readAllPages<Page>(
  fetchPage: (nextToken: string | undefined) => Page,
  nextTokenOf: (page: Page) => string | undefined,
  limitMessage: string,
): Page[] {
  const pages: Page[] = [];
  let nextToken: string | undefined;

  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
    const page = fetchPage(nextToken);

    pages.push(page);
    nextToken = nextTokenOf(page);

    if (!nextToken) {
      return pages;
    }
  }

  throw new Error(limitMessage);
}

/** The AWS CLI's `--next-token` arguments, or none for the first page. */
export function nextTokenArgs(nextToken: string | undefined): string[] {
  return nextToken ? ['--next-token', nextToken] : [];
}
