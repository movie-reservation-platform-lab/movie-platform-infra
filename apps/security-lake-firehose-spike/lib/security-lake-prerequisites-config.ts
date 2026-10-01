import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { AuditAccountConfig } from '@movie-platform/audit-account-config';
import { CUSTOM_SOURCE_PREFIX } from './custom-source-contract';

export const SECURITY_LAKE_PREREQUISITES_CONFIG_ENVIRONMENT_VARIABLE =
  'MOVIE_PLATFORM_SECURITY_LAKE_PREREQUISITES_CONFIG_FILE' as const;

/** Validated Security Lake data-lake values needed before custom-source creation. */
export interface SecurityLakePrerequisitesConfig {
  readonly bucketArn: string;
  readonly region: string;
  readonly sourcePrefix: typeof CUSTOM_SOURCE_PREFIX;
}

/** Expected private prerequisite-configuration failure safe to show at the CLI boundary. */
export class SecurityLakePrerequisitesConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SecurityLakePrerequisitesConfigError';
  }
}

/** Load and validate the private data-lake output used by the prerequisite stack. */
export function loadSecurityLakePrerequisitesConfig(
  environment: NodeJS.ProcessEnv,
  auditConfig: AuditAccountConfig,
): SecurityLakePrerequisitesConfig {
  const configFilepath =
    environment[SECURITY_LAKE_PREREQUISITES_CONFIG_ENVIRONMENT_VARIABLE];
  if (configFilepath === undefined || configFilepath.length === 0) {
    throw new SecurityLakePrerequisitesConfigError(
      `${SECURITY_LAKE_PREREQUISITES_CONFIG_ENVIRONMENT_VARIABLE} must name the config file.`,
    );
  }
  if (!isAbsolute(configFilepath)) {
    throw new SecurityLakePrerequisitesConfigError(
      `${SECURITY_LAKE_PREREQUISITES_CONFIG_ENVIRONMENT_VARIABLE} must be an absolute path.`,
    );
  }

  return parseSecurityLakePrerequisitesConfigJson(
    readFileSync(configFilepath, 'utf8'),
    auditConfig,
  );
}

/** Validate the untrusted data-lake values used to create the Glue crawler role. */
export function parseSecurityLakePrerequisitesConfigJson(
  contents: string,
  auditConfig: AuditAccountConfig,
): SecurityLakePrerequisitesConfig {
  const value = parseJsonObject(contents);
  const expectedKeys = ['bucketArn', 'region'] as const;
  if (
    Object.keys(value).length !== expectedKeys.length
    || !expectedKeys.every((key) => key in value)
  ) {
    throw new SecurityLakePrerequisitesConfigError(
      `Security Lake prerequisite config must contain exactly: ${expectedKeys.join(', ')}.`,
    );
  }

  const region = requireString(value.region, 'region');
  if (region !== auditConfig.region) {
    throw new SecurityLakePrerequisitesConfigError(
      'Security Lake prerequisite Region must match the configured audit Region.',
    );
  }

  const bucketArn = requireString(value.bucketArn, 'bucketArn');
  if (
    !/^arn:(?:aws|aws-us-gov|aws-cn):s3:::[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(
      bucketArn,
    )
  ) {
    throw new SecurityLakePrerequisitesConfigError(
      'bucketArn must identify one S3 bucket without an object prefix.',
    );
  }

  return Object.freeze({
    bucketArn,
    region,
    sourcePrefix: CUSTOM_SOURCE_PREFIX,
  });
}

function parseJsonObject(contents: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    throw new SecurityLakePrerequisitesConfigError(
      'Security Lake prerequisite config must contain valid JSON.',
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SecurityLakePrerequisitesConfigError(
      'Security Lake prerequisite config must be a JSON object.',
    );
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new SecurityLakePrerequisitesConfigError(
      `${fieldName} must be a nonblank string.`,
    );
  }
  return value;
}
