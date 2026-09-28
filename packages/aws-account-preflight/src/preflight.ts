import { isAbsolute, join } from 'node:path';

import { validateAwsCliIdentity } from './aws-cli';
import { fail } from './preflight-error';
import { loadAwsTarget } from './target-file';
import type { AwsTarget } from './target-schema';

/** Absolute shared-config paths used by both AWS CLI and downstream SDK clients. */
export interface ValidatedAwsConfigFiles {
  readonly configFilepath: string;
  readonly credentialsFilepath: string;
}

/**
 * Exact target, permission set, and shared-config paths proven by the preflight.
 *
 * Callers may use this value to construct clients for the pinned profile and
 * Region. They must not substitute ambient/default AWS credentials afterwards.
 */
export interface ValidatedAwsAccess {
  readonly target: AwsTarget;
  readonly permissionSet: string;
  readonly configFiles: ValidatedAwsConfigFiles;
}

/**
 * Validate the private target file, configured SSO profile, and live STS caller.
 *
 * @param environment - Process environment containing only path/configuration
 * inputs; competing AWS credential variables are rejected by the preflight.
 * @returns The frozen target, permission set, and exact config paths used by the identity gate.
 */
export function validateAwsAccess(environment: NodeJS.ProcessEnv): ValidatedAwsAccess {
  const target = loadAwsTarget(environment);
  const configFiles = resolveAwsConfigFiles(environment);
  const permissionSet = validateAwsCliIdentity(target, {
    ...environment,
    AWS_CONFIG_FILE: configFiles.configFilepath,
    AWS_SHARED_CREDENTIALS_FILE: configFiles.credentialsFilepath,
  });

  return Object.freeze({ target, permissionSet, configFiles });
}

/**
 * Execute the complete read-only target, profile, credential-source, and STS gate.
 *
 * @internal
 */
export function runPreflight(environment: NodeJS.ProcessEnv): string {
  const { target, permissionSet } = validateAwsAccess(environment);

  return [
    'AWS account preflight passed',
    `  profile: ${target.profile}`,
    `  region: ${target.region}`,
    `  permission set: ${permissionSet}`,
    `  account last four: ${target.accountId.slice(-4)}`,
    '',
  ].join('\n');
}

function resolveAwsConfigFiles(environment: NodeJS.ProcessEnv): ValidatedAwsConfigFiles {
  return Object.freeze({
    configFilepath: resolveAwsConfigFile(
      'AWS_CONFIG_FILE',
      environment.AWS_CONFIG_FILE,
      'config',
      environment,
    ),
    credentialsFilepath: resolveAwsConfigFile(
      'AWS_SHARED_CREDENTIALS_FILE',
      environment.AWS_SHARED_CREDENTIALS_FILE,
      'credentials',
      environment,
    ),
  });
}

function resolveAwsConfigFile(
  variableName: 'AWS_CONFIG_FILE' | 'AWS_SHARED_CREDENTIALS_FILE',
  override: string | undefined,
  defaultName: 'config' | 'credentials',
  environment: NodeJS.ProcessEnv,
): string {
  if (override !== undefined && override.length > 0) {
    if (!isAbsolute(override)) {
      fail(`${variableName} must be an absolute path`);
    }
    return override;
  }

  const home = environment.HOME;
  if (home === undefined || !isAbsolute(home)) {
    fail(`HOME must be an absolute path when ${variableName} is unset`);
  }
  return join(home, '.aws', defaultName);
}
