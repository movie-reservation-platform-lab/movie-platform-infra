import { relative, isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';

import { PreflightFailure, type ValidatedAwsAccess } from '@movie-platform/aws-account-preflight';

import { PrivateFileError } from '../adapters/private-files';
import { renderSummary } from '../adapters/terminal-summary';
import { describeError } from '../core/redaction';
import { runComparison, type ComparisonDependencies } from '../core/run-comparison';
import type { ComparisonContext, DemoCredentials } from '../core/settings';
import { RunConfigError, queueUrlLocation, type RunConfig } from './run-config';

export const EXIT_CODES = Object.freeze({
  passed: 0,
  comparisonFailed: 1,
  invalidInput: 2,
  unexpectedError: 3,
});

const USAGE = `Usage: npm run compare:audit-transports -- --run-file /absolute/run.json

Sends controlled demo logins, then polls the Security Lake and legacy audit
stores for the returned audit event IDs. Creates versioned JSON evidence at the
run file's "output" path and prints a summary. The only AWS mutation is an
optional, single Security Lake crawler start (securityLakeStore.refreshCatalog).

Exit codes: 0 passed, 1 comparison failed, 2 invalid input or preflight failure,
3 unexpected error (including evidence that could not be written).
`;

export interface CliStreams {
  stdout(text: string): void;
  stderr(text: string): void;
}

/** Everything the CLI touches outside its own logic; `production-dependencies.ts` wires the real ones. */
export interface CliDependencies {
  loadRunConfig(path: string): RunConfig;
  loadCredentials(path: string): DemoCredentials;
  validateAccess(targetFile: string, environment: NodeJS.ProcessEnv): ValidatedAwsAccess;
  verifySdkIdentity(access: ValidatedAwsAccess, label: string): Promise<void>;
  createComparisonDependencies(config: RunConfig, workload: ValidatedAwsAccess, audit: ValidatedAwsAccess): ComparisonDependencies;
  writeEvidence(path: string, contents: string): void;
  /** Evidence must never be written inside this public repository. */
  readonly repositoryRoot: string;
}

/** Errors that mean "fix your input", reported with exit code 2. */
class UsageError extends Error {
  public override readonly name = 'UsageError';
}

const INPUT_ERRORS = [RunConfigError, PrivateFileError, PreflightFailure, UsageError];

export async function runCli(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  streams: CliStreams,
  dependencies: CliDependencies,
): Promise<number> {
  let prepared: PreparedRun;
  try {
    const runFile = parseRunFileArgument(arguments_);
    if (runFile === null) {
      streams.stdout(USAGE);
      return EXIT_CODES.passed;
    }
    prepared = await prepareRun(runFile, environment, dependencies);
  } catch (error) {
    if (INPUT_ERRORS.some((type) => error instanceof type)) {
      streams.stderr(`audit transport comparison: ${describeError(error)}\n\n${USAGE}`);
      return EXIT_CODES.invalidInput;
    }
    throw error;
  }

  const { config, context, comparisonDependencies } = prepared;
  const result = await runComparison(config.settings, context, comparisonDependencies);
  streams.stdout(renderSummary(result));
  try {
    dependencies.writeEvidence(config.output, `${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    streams.stderr(`audit transport comparison: evidence not written: ${describeError(error)}\n`);
    return EXIT_CODES.unexpectedError;
  }
  // The output path is private (it names the operator's directories), so it is not echoed.
  streams.stdout('Evidence written to the run file\'s output path.\n');
  return result.status === 'passed' ? EXIT_CODES.passed : EXIT_CODES.comparisonFailed;
}

interface PreparedRun {
  readonly config: RunConfig;
  readonly context: ComparisonContext;
  readonly comparisonDependencies: ComparisonDependencies;
}

/** @returns the run file path, or `null` when help was requested. */
function parseRunFileArgument(arguments_: readonly string[]): string | null {
  let values: { 'run-file'?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: [...arguments_],
      options: { 'run-file': { type: 'string' }, help: { type: 'boolean' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    // parseArgs messages echo the offending argument; keep them out of the output.
    throw new UsageError('unsupported arguments');
  }
  if (values.help === true) {
    return null;
  }
  if (values['run-file'] === undefined) {
    throw new UsageError('--run-file is required');
  }
  return values['run-file'];
}

/** Load inputs, preflight both accounts, and check they fit together, before any login is sent. */
async function prepareRun(
  runFile: string,
  environment: NodeJS.ProcessEnv,
  dependencies: CliDependencies,
): Promise<PreparedRun> {
  rejectEndpointOverrides(environment);
  const config = dependencies.loadRunConfig(runFile);
  rejectOutputInside(config.output, dependencies.repositoryRoot);
  const credentials = dependencies.loadCredentials(config.credentialsFile);
  const workload = dependencies.validateAccess(config.workloadTargetFile, environment);
  const audit = dependencies.validateAccess(config.auditTargetFile, environment);
  if (workload.target.accountId === audit.target.accountId) {
    throw new UsageError('the workload and audit targets must be different accounts');
  }
  const queue = queueUrlLocation(config.deliveryHealth.deadLetterQueueUrl);
  if (queue.accountId !== audit.target.accountId || queue.region !== audit.target.region) {
    throw new UsageError('deliveryHealth.deadLetterQueueUrl must belong to the audit target account and Region');
  }
  await dependencies.verifySdkIdentity(workload, 'workload');
  await dependencies.verifySdkIdentity(audit, 'audit');

  return {
    config,
    context: { credentials, workloadAccountId: workload.target.accountId, region: workload.target.region },
    comparisonDependencies: dependencies.createComparisonDependencies(config, workload, audit),
  };
}

/** Endpoint overrides would send the signed SDK calls somewhere other than AWS. */
function rejectEndpointOverrides(environment: NodeJS.ProcessEnv): void {
  if (Object.keys(environment).some((name) => name.startsWith('AWS_ENDPOINT_URL'))) {
    throw new UsageError('AWS_ENDPOINT_URL* overrides are not allowed');
  }
}

function rejectOutputInside(output: string, repositoryRoot: string): void {
  const path = relative(repositoryRoot, output);
  if (path === '' || (!path.startsWith('..') && !isAbsolute(path))) {
    throw new UsageError('output must be outside this public repository');
  }
}
