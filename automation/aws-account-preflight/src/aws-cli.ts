import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { fail } from './preflight-error';
import type { AwsTarget } from './target-schema';

const AWS_CLI_TIMEOUT_MILLISECONDS = 30_000;
const CREDENTIAL_ENVIRONMENT_VARIABLES = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
  'AWS_ROLE_ARN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
] as const;
const NON_SSO_PROFILE_KEYS = [
  'credential_process',
  'credential_source',
  'role_arn',
  'source_profile',
  'web_identity_token_file',
  'login_session',
] as const;

interface ProfileConfiguration {
  readonly accountId: string;
  readonly permissionSet: string;
  readonly ssoSession: string;
  readonly region: string;
  readonly ssoRegion: string;
}

interface RoleIdentity {
  readonly accountId: string;
  readonly roleName: string;
}

/**
 * Validate that the named AWS CLI profile resolves to the exact pinned target.
 *
 * The environment, shared AWS configuration, and STS response remain untrusted
 * runtime inputs. This function rejects competing credential providers before
 * asking AWS CLI v2 to inspect the SSO profile and call GetCallerIdentity.
 *
 * @returns The validated permission-set name for the redacted success report.
 * @internal
 */
export function validateAwsCliIdentity(target: AwsTarget, environment: NodeJS.ProcessEnv): string {
  rejectCredentialEnvironment(environment);
  requireAwsCliV2(environment);

  const profile = readAndValidateProfile(target, environment);
  const caller = readAndValidateCaller(target, environment);

  if (caller.accountId !== target.accountId) {
    fail('the live caller account does not match the pinned target');
  }
  if (caller.roleName !== target.expectedRoleName) {
    fail('the live caller role does not match the pinned target');
  }

  return profile.permissionSet;
}

/**
 * Run deterministic identity-helper checks without credentials or network access.
 *
 * @internal
 */
export function runAwsIdentitySelfTest(): void {
  const arn =
    'arn:aws:sts::111111111111:assumed-role/AWSReservedSSO_AdministratorAccess_0123456789abcdef/test-session';
  const identity = roleIdentityFromStsArn(arn);
  if (
    identity?.accountId !== '111111111111' ||
    identity.roleName !== 'AWSReservedSSO_AdministratorAccess_0123456789abcdef' ||
    roleIdentityFromStsArn('arn:aws:iam::111111111111:user/long-lived-user') !== undefined ||
    !roleMatchesPermissionSet(
      'AWSReservedSSO_AdministratorAccess_0123456789abcdef',
      'AdministratorAccess',
    ) ||
    roleMatchesPermissionSet(
      'AWSReservedSSO_AdministratorAccess_0123456789abcdee',
      'PowerUserAccess',
    )
  ) {
    fail('internal self-test failed');
  }
}

function rejectCredentialEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const variableName of CREDENTIAL_ENVIRONMENT_VARIABLES) {
    if ((environment[variableName] ?? '').length > 0) {
      fail(`${variableName} must be unset so the named SSO profile is authoritative`);
    }
  }
}

function requireAwsCliV2(environment: NodeJS.ProcessEnv): void {
  const result = runAws(['--version'], environment);
  const version = `${result.stdout}${result.stderr}`.trim();
  if (result.status !== 0 || result.error !== undefined) {
    fail('unable to read the AWS CLI version');
  }
  if (!version.startsWith('aws-cli/2.')) {
    fail('AWS CLI v2 is required for IAM Identity Center login');
  }
}

function readAndValidateProfile(target: AwsTarget, environment: NodeJS.ProcessEnv): ProfileConfiguration {
  const accountId = readProfileValue('sso_account_id', target, environment);
  const permissionSet = readProfileValue('sso_role_name', target, environment);
  const ssoSession = readProfileValue('sso_session', target, environment);
  const region = readProfileValue('region', target, environment);

  if (accountId.length === 0) {
    fail('the profile has no sso_account_id');
  }
  if (permissionSet.length === 0) {
    fail('the profile has no sso_role_name');
  }
  if (ssoSession.length === 0) {
    fail('the profile must use the AWS CLI v2 SSO token-provider configuration');
  }
  if (region.length === 0) {
    fail('the profile has no default region');
  }

  const ssoRegion = readSsoSessionValue('sso_region', ssoSession, environment);
  if (ssoRegion.length === 0) {
    fail('the SSO session has no sso_region');
  }

  const staticCredentialValues = [
    readProfileValue('aws_access_key_id', target, environment),
    readProfileValue('aws_secret_access_key', target, environment),
    readProfileValue('aws_session_token', target, environment),
  ];
  if (staticCredentialValues.some((value) => value.length > 0)) {
    fail('the profile contains static or cached credentials');
  }

  const alternativeProviderValues = NON_SSO_PROFILE_KEYS.map((key) =>
    readProfileValue(key, target, environment),
  );
  if (alternativeProviderValues.some((value) => value.length > 0)) {
    fail('the profile contains a non-SSO credential provider');
  }

  if (accountId !== target.accountId) {
    fail('the profile account does not match the pinned target');
  }
  if (region !== target.region) {
    fail('the profile Region does not match the pinned target');
  }
  if (ssoRegion !== target.region) {
    fail('the SSO session Region does not match the pinned target');
  }
  if (!roleMatchesPermissionSet(target.expectedRoleName, permissionSet)) {
    fail('the profile permission set does not match the pinned target role');
  }

  return Object.freeze({ accountId, permissionSet, ssoSession, region, ssoRegion });
}

function readAndValidateCaller(target: AwsTarget, environment: NodeJS.ProcessEnv): RoleIdentity {
  const result = runAws(
    [
      'sts',
      'get-caller-identity',
      '--profile',
      target.profile,
      '--region',
      target.region,
      '--no-cli-pager',
      '--query',
      '[Account,Arn]',
      '--output',
      'text',
    ],
    environment,
  );
  if (result.status !== 0 || result.error !== undefined) {
    fail('STS GetCallerIdentity failed; refresh the configured SSO login');
  }

  const identityLine = withoutOneTrailingLineEnding(result.stdout);
  if (identityLine.includes('\n') || identityLine.includes('\r')) {
    fail('STS returned an unexpected caller identity shape');
  }
  const fields = identityLine.split('\t');
  if (fields.length !== 2 || !/^[0-9]{12}$/.test(fields[0]) || fields[1].length === 0) {
    fail('STS returned an unexpected caller identity shape');
  }

  const caller = roleIdentityFromStsArn(fields[1]);
  if (caller === undefined) {
    fail('the caller is not an IAM Identity Center assumed-role session');
  }
  if (fields[0] !== target.accountId || caller.accountId !== target.accountId) {
    fail('the live caller account does not match the pinned target');
  }
  return caller;
}

function roleIdentityFromStsArn(arn: string): RoleIdentity | undefined {
  const match = /^arn:aws:sts::([0-9]{12}):assumed-role\/([^/]+)\/([^/]+)$/.exec(arn);
  if (match === null) {
    return undefined;
  }

  return Object.freeze({ accountId: match[1], roleName: match[2] });
}

function roleMatchesPermissionSet(roleName: string, permissionSet: string): boolean {
  if (permissionSet.length === 0) {
    return false;
  }

  const expectedPrefix = `AWSReservedSSO_${permissionSet}_`;
  if (!roleName.startsWith(expectedPrefix)) {
    return false;
  }

  return /^[0-9a-fA-F]{16}$/.test(roleName.slice(expectedPrefix.length));
}

function readProfileValue(key: string, target: AwsTarget, environment: NodeJS.ProcessEnv): string {
  const result = runAws(['configure', 'get', key, '--profile', target.profile], environment);
  return result.status === 0 && result.error === undefined
    ? withoutOneTrailingLineEnding(result.stdout)
    : '';
}

function readSsoSessionValue(key: string, ssoSession: string, environment: NodeJS.ProcessEnv): string {
  const result = runAws(['configure', 'get', '--sso-session', ssoSession, key], environment);
  return result.status === 0 && result.error === undefined
    ? withoutOneTrailingLineEnding(result.stdout)
    : '';
}

/**
 * Invoke the operator's AWS CLI without shell interpretation or interactive UI.
 *
 * Synchronous execution is intentional for this short-lived serial guard. The
 * timeout prevents a stuck CLI/network operation from blocking indefinitely.
 */
function runAws(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): SpawnSyncReturns<string> {
  return spawnSync('aws', arguments_, {
    encoding: 'utf8',
    env: {
      ...environment,
      AWS_CLI_AUTO_PROMPT: 'off',
      AWS_PAGER: '',
    },
    shell: false,
    timeout: AWS_CLI_TIMEOUT_MILLISECONDS,
  });
}

function withoutOneTrailingLineEnding(value: string): string {
  return value.endsWith('\r\n') ? value.slice(0, -2) : value.endsWith('\n') ? value.slice(0, -1) : value;
}
