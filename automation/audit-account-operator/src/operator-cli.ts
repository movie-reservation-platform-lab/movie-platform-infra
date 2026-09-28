import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import {
  PreflightFailure,
  validateAwsAccess,
  type ValidatedAwsAccess,
} from '@movie-platform/aws-account-preflight';
import {
  AuditAccountConfigError,
  loadAuditAccountConfig,
  type AuditAccountConfig,
} from '@movie-platform/audit-account-config';
import {
  AuditAccountTargetError,
  validateAuditAccountTarget,
  type ValidatedAuditAccountTarget,
} from './audit-account-target';

type OperatorCommand = 'preflight' | 'status' | 'bootstrap';

interface OperatorStreams {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

interface ProcessResult {
  readonly status: number | null;
  readonly stdout: string;
}

interface OperatorDependencies {
  readonly loadConfig: (environment: NodeJS.ProcessEnv) => AuditAccountConfig;
  readonly validateAccess: (environment: NodeJS.ProcessEnv) => ValidatedAwsAccess;
  readonly runProcess: (
    executable: string,
    arguments_: readonly string[],
    environment: NodeJS.ProcessEnv,
  ) => ProcessResult;
}

interface ParsedOperatorArguments {
  readonly command: OperatorCommand;
  readonly execute: boolean;
}

const PROCESS_STREAMS: OperatorStreams = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

const DEFAULT_DEPENDENCIES: OperatorDependencies = {
  loadConfig: loadAuditAccountConfig,
  validateAccess: validateAwsAccess,
  runProcess: (executable, arguments_, environment) => {
    const result = spawnSync(executable, [...arguments_], {
      encoding: 'utf8',
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    return { status: result.status, stdout: result.stdout };
  },
};

/** Run the audit-account operator boundary with injectable process adapters. */
export function runOperatorCli(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  streams: OperatorStreams = PROCESS_STREAMS,
  dependencies: OperatorDependencies = DEFAULT_DEPENDENCIES,
): number {
  try {
    const options = parseOperatorArguments(arguments_);
    const target = validateAuditAccountTarget(
      dependencies.loadConfig(environment),
      dependencies.validateAccess(environment),
    );

    if (options.command === 'preflight') {
      streams.stdout(renderPreflightSuccess(target));
      return 0;
    }
    if (options.command === 'status') {
      return runStatus(target, environment, streams, dependencies);
    }
    if (!options.execute) {
      streams.stdout(
        'Audit-account bootstrap plan passed preflight; rerun with --execute only during an authorized live operation.\n',
      );
      return 0;
    }
    return runBootstrap(target, environment, streams, dependencies);
  } catch (error: unknown) {
    const message =
      error instanceof PreflightFailure ||
      error instanceof AuditAccountConfigError ||
      error instanceof AuditAccountTargetError
        ? error.message
        : error instanceof Error && error.message.startsWith('invalid arguments')
          ? error.message
          : 'unexpected internal error';
    streams.stderr(`Audit-account operation failed: ${message}\n`);
    return 1;
  }
}

function parseOperatorArguments(arguments_: readonly string[]): ParsedOperatorArguments {
  try {
    const { positionals, values } = parseArgs({
      args: [...arguments_],
      options: {
        execute: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: true,
    });
    if (positionals.length !== 1 || !isOperatorCommand(positionals[0])) {
      throw new Error('invalid arguments; expected preflight, status, or bootstrap');
    }
    if (values.execute === true && positionals[0] !== 'bootstrap') {
      throw new Error('invalid arguments; --execute is allowed only with bootstrap');
    }
    return { command: positionals[0], execute: values.execute ?? false };
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('invalid arguments')) {
      throw error;
    }
    throw new Error('invalid arguments; expected preflight, status, or bootstrap');
  }
}

function isOperatorCommand(value: string): value is OperatorCommand {
  return value === 'preflight' || value === 'status' || value === 'bootstrap';
}

function runStatus(
  target: ValidatedAuditAccountTarget,
  environment: NodeJS.ProcessEnv,
  streams: OperatorStreams,
  dependencies: OperatorDependencies,
): number {
  const result = dependencies.runProcess(
    'aws',
    [
      'cloudformation',
      'describe-stacks',
      '--stack-name',
      'CDKToolkit',
      '--query',
      'Stacks[0].StackStatus',
      '--output',
      'text',
      '--profile',
      target.access.target.profile,
      '--region',
      target.config.region,
    ],
    validatedProcessEnvironment(environment, target.access),
  );
  const status = result.stdout.trim();
  if (result.status !== 0 || !/^[A-Z][A-Z_]+$/.test(status)) {
    streams.stderr('Audit-account CDK bootstrap status is unavailable.\n');
    return 1;
  }
  streams.stdout(`Audit-account CDK bootstrap status: ${status}\n`);
  return 0;
}

function runBootstrap(
  target: ValidatedAuditAccountTarget,
  environment: NodeJS.ProcessEnv,
  streams: OperatorStreams,
  dependencies: OperatorDependencies,
): number {
  const result = dependencies.runProcess(
    'cdk',
    [
      'bootstrap',
      `aws://${target.config.auditAccountId}/${target.config.region}`,
      '--profile',
      target.access.target.profile,
    ],
    validatedProcessEnvironment(environment, target.access),
  );
  if (result.status !== 0) {
    streams.stderr('Audit-account CDK bootstrap failed; inspect the private operator terminal.\n');
    return 1;
  }
  streams.stdout('Audit-account CDK bootstrap completed.\n');
  return 0;
}

function validatedProcessEnvironment(
  environment: NodeJS.ProcessEnv,
  access: ValidatedAwsAccess,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    AWS_CONFIG_FILE: access.configFiles.configFilepath,
    AWS_SHARED_CREDENTIALS_FILE: access.configFiles.credentialsFilepath,
  };
}

function renderPreflightSuccess(target: ValidatedAuditAccountTarget): string {
  return [
    'Audit-account preflight passed',
    `  profile: ${target.access.target.profile}`,
    `  region: ${target.config.region}`,
    `  permission set: ${target.access.permissionSet}`,
    `  account last four: ${target.config.auditAccountId.slice(-4)}`,
    '',
  ].join('\n');
}
