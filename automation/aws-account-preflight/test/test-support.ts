import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { runCli } from '../src';

export const EXPECTED_ACCOUNT_ID = '111111111111';
export const EXPECTED_ROLE_SUFFIX = '0123456789abcdef';
export const EXPECTED_ROLE_NAME = `AWSReservedSSO_AdministratorAccess_${EXPECTED_ROLE_SUFFIX}`;
export const SESSION_NAME = 'operator@example.invalid';
export const VALID_TARGET_VALUE = Object.freeze({
  profile: 'movie-platform-demo',
  region: 'eu-central-1',
  accountId: EXPECTED_ACCOUNT_ID,
  expectedRoleName: EXPECTED_ROLE_NAME,
});
export const VALID_TARGET = serializeTarget(VALID_TARGET_VALUE);
export const CREDENTIAL_ENVIRONMENT_VARIABLES = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
  'AWS_ROLE_ARN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
] as const;

const AWS_STUB_SOURCE = path.join(__dirname, 'fixtures', 'aws-stub.sh');

export interface PreflightFixture {
  readonly directory: string;
  readonly configRoot: string;
  readonly targetFile: string;
  readonly awsMarker: string;
  readonly stsMarker: string;
  readonly cleanup: () => void;
}

export interface PreflightResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Create an operator target and fake AWS executable in a private temporary tree. */
export function createFixture(targetContents: string = VALID_TARGET): PreflightFixture {
  const directory = mkdtempSync(path.join(tmpdir(), 'aws-account-preflight-'));
  const configRoot = path.join(directory, 'config');
  const targetDirectory = path.join(configRoot, 'movie-platform');
  const targetFile = path.join(targetDirectory, 'aws-target.json');
  const awsMarker = path.join(directory, 'aws-called');
  const stsMarker = path.join(directory, 'sts-called');

  mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(targetFile, targetContents, { mode: 0o600 });
  writeFileSync(awsMarker, '');
  writeFileSync(stsMarker, '');
  writeExecutable(path.join(directory, 'aws'), readFileSync(AWS_STUB_SOURCE, 'utf8'));

  return {
    directory,
    configRoot,
    targetFile,
    awsMarker,
    stsMarker,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

/** Execute the preflight through its public CLI seam with one test fixture. */
export function runFixturePreflight(
  fixture: PreflightFixture,
  envOverrides: Readonly<Record<string, string | undefined>> = {},
): PreflightResult {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${fixture.directory}:${process.env.PATH ?? ''}`,
    MOVIE_PLATFORM_AWS_TARGET_FILE: fixture.targetFile,
    AWS_STUB_VERSION: 'aws-cli/2.36.2 Python/3.13.0 Linux/test',
    AWS_STUB_PROFILE_ACCOUNT: EXPECTED_ACCOUNT_ID,
    AWS_STUB_PROFILE_PERMISSION_SET: 'AdministratorAccess',
    AWS_STUB_PROFILE_SSO_SESSION: 'movie-platform-demo',
    AWS_STUB_PROFILE_REGION: 'eu-central-1',
    AWS_STUB_SSO_REGION: 'eu-central-1',
    AWS_STUB_CALLER_ACCOUNT: EXPECTED_ACCOUNT_ID,
    AWS_STUB_CALLER_ARN:
      `arn:aws:sts::${EXPECTED_ACCOUNT_ID}:assumed-role/${EXPECTED_ROLE_NAME}/${SESSION_NAME}`,
    AWS_STUB_AWS_MARKER: fixture.awsMarker,
    AWS_STUB_STS_MARKER: fixture.stsMarker,
  };

  for (const variableName of CREDENTIAL_ENVIRONMENT_VARIABLES) {
    delete environment[variableName];
  }
  Object.assign(environment, envOverrides);
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete environment[key];
    }
  }

  return runPreflightProcess([], environment);
}

/** Invoke `runCli` while capturing output instead of mutating process streams. */
export function runPreflightProcess(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): PreflightResult {
  let stdout = '';
  let stderr = '';
  const status = runCli(arguments_, environment, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });

  return { status, stdout, stderr };
}

export function expectSuccessfulRedactedResult(result: PreflightResult): void {
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toContain('AWS account preflight passed');
  expectPrivateValuesAbsent(result);
}

export function expectPrivateValuesAbsent(
  result: PreflightResult,
  additionalPrivateValues: readonly string[] = [],
): void {
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  const privateValues = [
    EXPECTED_ACCOUNT_ID,
    EXPECTED_ROLE_NAME,
    EXPECTED_ROLE_SUFFIX,
    SESSION_NAME,
    ...additionalPrivateValues,
  ];

  for (const privateValue of privateValues) {
    if (privateValue.length > 4) {
      expect(combinedOutput).not.toContain(privateValue);
    }
  }
}

export function serializeTarget(value: unknown): string {
  return `${JSON.stringify(value, undefined, 2)}\n`;
}

function writeExecutable(filePath: string, contents: string): void {
  writeFileSync(filePath, contents);
  chmodSync(filePath, 0o755);
}
