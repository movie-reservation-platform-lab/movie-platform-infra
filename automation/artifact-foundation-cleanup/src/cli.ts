import { parseArgs } from 'node:util';

import {
  PreflightFailure,
  validateAwsAccess,
  type ValidatedAwsAccess,
} from '../../aws-account-preflight/src';
import { ARTIFACT_FOUNDATION_REPOSITORIES } from '../../../lib/artifact-foundation-repositories';
import { createAwsSdkCleaner } from './aws-cleanup-client';
import { createAwsSdkReader } from './aws-read-client';
import {
  executeArtifactFoundationCleanup,
  planArtifactFoundationCleanup,
} from './cleanup';
import { CleanupFailure, failCleanup } from './cleanup-error';
import { inspectArtifactFoundation } from './inspection';
import { InspectionFailure, failInspection } from './inspection-error';
import type {
  ArtifactFoundationCleaner,
  ArtifactFoundationReader,
  ArtifactRepositoryCatalog,
  CleanupInspectionAccess,
} from './model';
import {
  renderExecutionPlan,
  renderExecutionResult,
  renderInspectionReport,
} from './report';

/** Parse CLI input, wire adapters, and render the cleanup-readiness report. */
export async function runCli(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  streams: CliStreams = PROCESS_STREAMS,
  dependencies: CliDependencies = PRODUCTION_DEPENDENCIES,
): Promise<number> {
  let operation: 'inspection' | 'cleanup' = 'inspection';
  try {
    const options = parseCliOptions(arguments_);
    if (options.help) {
      streams.stdout(USAGE);
      return 0;
    }
    operation = options.execute ? 'cleanup' : 'inspection';
    const confirmation = options.confirmation;
    if (options.execute && confirmation === undefined) {
      failCleanup('--execute requires an exact --confirm value; run the read-only check first');
    }
    if (!options.execute && confirmation !== undefined) {
      failInspection('--confirm is valid only together with --execute');
    }

    const access = dependencies.validateAccess(environment);
    const reader = dependencies.createReader(access);
    const inspection = await inspectArtifactFoundation(
      toInspectionAccess(access),
      reader,
      dependencies.artifactRepositoryCatalog,
    );
    streams.stdout(renderInspectionReport(inspection));

    if (!options.execute) {
      return 0;
    }

    const plan = planArtifactFoundationCleanup(
      inspection,
      confirmation ?? failCleanup('--execute requires an exact --confirm value'),
    );
    streams.stdout(renderExecutionPlan(plan));
    const cleaner = dependencies.createCleaner(access);
    const result = await executeArtifactFoundationCleanup(
      plan,
      cleaner,
      async () =>
        inspectArtifactFoundation(
          toInspectionAccess(access),
          reader,
          dependencies.artifactRepositoryCatalog,
        ),
    );
    streams.stdout(renderExecutionResult(result));
    return 0;
  } catch (error: unknown) {
    const message =
      error instanceof PreflightFailure ||
      error instanceof InspectionFailure ||
      error instanceof CleanupFailure
        ? error.message
        : 'unexpected internal error';
    streams.stderr(`Artifact foundation ${operation} failed: ${message}\n`);
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
  readonly createCleaner: (access: ValidatedAwsAccess) => ArtifactFoundationCleaner;
  readonly artifactRepositoryCatalog: ArtifactRepositoryCatalog;
}

interface CliOptions {
  readonly help: boolean;
  readonly execute: boolean;
  readonly confirmation?: string;
}

const PROCESS_STREAMS: CliStreams = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

const LOCAL_ARTIFACT_REPOSITORY_CATALOG: ArtifactRepositoryCatalog = Object.freeze({
  listArtifactRepositories: () => ARTIFACT_FOUNDATION_REPOSITORIES,
});

const PRODUCTION_DEPENDENCIES: CliDependencies = {
  validateAccess: validateAwsAccess,
  createReader: createAwsSdkReader,
  createCleaner: createAwsSdkCleaner,
  artifactRepositoryCatalog: LOCAL_ARTIFACT_REPOSITORY_CATALOG,
};

const CLI_OPTIONS = {
  help: {
    type: 'boolean',
    short: 'h',
  },
  execute: {
    type: 'boolean',
  },
  confirm: {
    type: 'string',
  },
} as const;

const USAGE = [
  'Usage: npm run cleanup:artifact-foundation -- [--help]',
  '       npm run cleanup:artifact-foundation -- --execute --confirm "<exact phrase>"',
  '',
  'Checks whether final project cleanup can proceed for ArtifactFoundationStack',
  'and the retained ECR repositories in the artifact destination catalog',
  '(currently reservation-service -> movie-reservation-service).',
  '',
  'The check runs the account preflight, refuses cleanup while MovieReservationWorkloadStack',
  'exists, inventories the exact stack/repository/images, and reports BLOCKED,',
  'READY, or NOTHING_TO_CLEAN.',
  '',
  'Without --execute the command is always read-only and prints the exact',
  'target-specific confirmation phrase. Execution disables stack termination',
  'protection, deletes and waits for the foundation stack, force-deletes the',
  'retained ECR repositories and images, then verifies final absence.',
  '',
  'WARNING: --execute is destructive. It preserves MovieReservationWorkloadStack,',
  'CDKToolkit, the ingress prefix list, and account-level identity/governance.',
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
    return Object.freeze({
      help: values.help ?? false,
      execute: values.execute ?? false,
      confirmation: values.confirm,
    });
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
