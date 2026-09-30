import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { AuditAccountConfig } from '@movie-platform/audit-account-config';

export const SECURITY_LAKE_FIREHOSE_SPIKE_CONFIG_ENVIRONMENT_VARIABLE =
  'MOVIE_PLATFORM_SECURITY_LAKE_FIREHOSE_SPIKE_CONFIG_FILE' as const;

/** Validated output returned when the operator creates the temporary custom source. */
export interface SecurityLakeSourceConfig {
  readonly bucketName: string;
  readonly providerRoleArn: string;
  readonly providerRoleName: string;
  readonly sourceAccountId: string;
  readonly sourceLocation: string;
  readonly sourcePrefix: string;
}

/** Expected configuration failure safe to show at the CLI boundary. */
export class SecurityLakeSourceConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SecurityLakeSourceConfigError';
  }
}

/**
 * Load and validate private custom-source output from an explicit absolute path.
 *
 * @param environment
 * @param auditConfig
 */
export function loadSecurityLakeSourceConfig(
  environment: NodeJS.ProcessEnv,
  auditConfig: AuditAccountConfig,
): SecurityLakeSourceConfig {
  const configFilepath = environment[SECURITY_LAKE_FIREHOSE_SPIKE_CONFIG_ENVIRONMENT_VARIABLE];
  if (configFilepath === undefined || configFilepath.length === 0) {
    throw new SecurityLakeSourceConfigError(
      `${SECURITY_LAKE_FIREHOSE_SPIKE_CONFIG_ENVIRONMENT_VARIABLE} must name the config file.`,
    );
  }
  if (!isAbsolute(configFilepath)) {
    throw new SecurityLakeSourceConfigError(
      `${SECURITY_LAKE_FIREHOSE_SPIKE_CONFIG_ENVIRONMENT_VARIABLE} must be an absolute path.`,
    );
  }

  return parseSecurityLakeSourceConfigJson(
    readFileSync(configFilepath, 'utf8'),
    auditConfig,
  );
}

/** Validate the untrusted response values needed by the Firehose delivery stack. */
export function parseSecurityLakeSourceConfigJson(
  contents: string,
  auditConfig: AuditAccountConfig,
): SecurityLakeSourceConfig {
  const value = parseJsonObject(contents);
  const expectedKeys = ['providerRoleArn', 'sourceAccountId', 'sourceLocation'] as const;
  if (
    Object.keys(value).length !== expectedKeys.length
    || !expectedKeys.every((key) => key in value)
  ) {
    throw new SecurityLakeSourceConfigError(
      `custom-source config must contain exactly: ${expectedKeys.join(', ')}.`,
    );
  }

  const sourceAccountId = requireString(value.sourceAccountId, 'sourceAccountId');
  if (!auditConfig.workloadAccountIds.includes(sourceAccountId)) {
    throw new SecurityLakeSourceConfigError(
      'sourceAccountId must be one of the configured workload accounts.',
    );
  }

  const sourceLocation = requireString(value.sourceLocation, 'sourceLocation');
  const location = parseSourceLocation(sourceLocation);
  const providerRoleArn = requireString(value.providerRoleArn, 'providerRoleArn');
  const roleMatch = providerRoleArn.match(
    /^arn:(?:aws|aws-us-gov|aws-cn):iam::([0-9]{12}):role\/(AmazonSecurityLake-Provider-[A-Za-z0-9._:+,=@-]+)$/,
  );
  if (
    roleMatch === null
    || roleMatch[1] !== auditConfig.auditAccountId
    || !roleMatch[2].endsWith(`-${auditConfig.region}`)
  ) {
    throw new SecurityLakeSourceConfigError(
      'providerRoleArn must identify a Security Lake provider role in the audit account.',
    );
  }

  return Object.freeze({
    ...location,
    providerRoleArn,
    providerRoleName: roleMatch[2],
    sourceAccountId,
    sourceLocation,
  });
}

function parseJsonObject(contents: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    throw new SecurityLakeSourceConfigError('custom-source config must contain valid JSON.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SecurityLakeSourceConfigError('custom-source config must be a JSON object.');
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new SecurityLakeSourceConfigError(`${fieldName} must be a nonblank string.`);
  }
  return value;
}

function parseSourceLocation(sourceLocation: string): {
  readonly bucketName: string;
  readonly sourcePrefix: string;
} {
  let location: URL;
  try {
    location = new URL(sourceLocation);
  } catch {
    throw new SecurityLakeSourceConfigError('sourceLocation must be a valid S3 URL.');
  }
  const sourcePrefix = location.pathname.slice(1);
  if (
    location.protocol !== 's3:'
    || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(location.hostname)
    || !sourcePrefix.startsWith('ext/')
    || !sourcePrefix.endsWith('/')
    || sourcePrefix.includes('..')
  ) {
    throw new SecurityLakeSourceConfigError(
      'sourceLocation must identify an assigned Security Lake ext/ prefix.',
    );
  }
  return { bucketName: location.hostname, sourcePrefix };
}
