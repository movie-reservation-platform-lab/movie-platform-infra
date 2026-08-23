import { parseArgs } from 'node:util';

import {
  PreflightFailure,
  validateAwsAccess,
  type ValidatedAwsAccess,
} from '../../aws-account-preflight/src';
import { createAwsSdkReader } from './aws-read-client';
import { inspectArtifactFoundation } from './inspection';
import { InspectionFailure, failInspection } from './inspection-error';
import type { ArtifactFoundationReader, CleanupInspectionAccess } from './model';
import { renderInspectionReport } from './report';

/** Parse CLI input, wire adapters, and render the cleanup-readiness report. */
export async function runCli(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  streams: CliStreams = PROCESS_STREAMS,
  dependencies: CliDependencies = PRODUCTION_DEPENDENCIES,
): Promise<number> {
  try {
    const options = parseCliOptions(arguments_);
    if (options.help) {
      streams.stdout(USAGE);
      return 0;
    }

    const access = dependencies.validateAccess(environment);
    const reader = dependencies.createReader(access);
    const inspection = await inspectArtifactFoundation(toInspectionAccess(access), reader);
    streams.stdout(renderInspectionReport(inspection));
    return 0;
  } catch (error: unknown) {
    const message =
      error instanceof PreflightFailure || error instanceof InspectionFailure
        ? error.message
        : 'unexpected internal error';
    streams.stderr(`Artifact foundation inspection failed: ${message}\n`);
    return 1;
  }
}

export interface CliStreams {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface CliDependencies {
  readonly validateAccess: (environment: NodeJS.ProcessEnv) => ValidatedAwsAccess;
  readonly createReader: (access: ValidatedAwsAccess) => ArtifactFoundationReader;
}

interface CliOptions {
  readonly help: boolean;
}

const PROCESS_STREAMS: CliStreams = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

const PRODUCTION_DEPENDENCIES: CliDependencies = {
  validateAccess: validateAwsAccess,
  createReader: createAwsSdkReader,
};

const CLI_OPTIONS = {
  help: {
    type: 'boolean',
    short: 'h',
  },
} as const;

const USAGE = [
  'Usage: npm run inspect:artifact-foundation -- [--help]',
  '',
  'Checks whether final project cleanup can proceed for ArtifactFoundationStack',
  'and its retained ECR repositories (currently only movie-reservation-service).',
  '',
  'The check runs the account preflight, refuses cleanup while GoldenPathDemoStack',
  'exists, inventories the exact stack/repository/images, and reports BLOCKED,',
  'READY, or NOTHING_TO_CLEAN.',
  '',
  'This PR is dry-run only: there is no --execute option and no AWS resource can',
  'be changed or deleted.',
  '',
].join('\n');

function parseCliOptions(arguments_: readonly string[]): CliOptions {
  try {
    const { values } = parseArgs({
      args: [...arguments_],
      options: CLI_OPTIONS,
      strict: true,
      allowPositionals: false,
    });
    return Object.freeze({ help: values.help ?? false });
  } catch {
    failInspection('invalid arguments; run with --help for usage');
  }
}

function toInspectionAccess(access: ValidatedAwsAccess): CleanupInspectionAccess {
  return Object.freeze({
    target: Object.freeze({
      profile: access.target.profile,
      region: access.target.region,
      accountId: access.target.accountId,
      expectedRoleName: access.target.expectedRoleName,
    }),
    permissionSet: access.permissionSet,
  });
}
