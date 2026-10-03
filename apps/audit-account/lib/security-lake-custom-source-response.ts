import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { SecurityLakeDestination } from '@movie-platform/audit-ingestion';
import {
  CUSTOM_SOURCE_NAME,
  CUSTOM_SOURCE_VERSION,
  CUSTOM_SOURCE_VERSIONED_PREFIX,
} from './security-lake-contract';

/**
 * Absolute path to a private local copy of the CreateCustomLogSource response.
 *
 * This file is an AWS resource-creation receipt describing the custom source;
 * it is not a configuration authored by us and it does not contain audit events.
 */
export const SECURITY_LAKE_CUSTOM_SOURCE_RESPONSE_ENVIRONMENT_VARIABLE =
  'MOVIE_PLATFORM_SECURITY_LAKE_CUSTOM_SOURCE_RESPONSE_FILE' as const;

/** Trusted destination details extracted from the AWS custom-source receipt. */
export interface SecurityLakeCustomSourceResponse {
  readonly destination: SecurityLakeDestination;
  readonly sourceName: typeof CUSTOM_SOURCE_NAME;
  readonly sourceVersion: typeof CUSTOM_SOURCE_VERSION;
}

/**
 * Load the privately saved AWS creation receipt and validate it before CDK use.
 *
 * The receipt is written by the guarded CreateCustomLogSource operation between
 * the foundation and ingestion deployments. It tells Firehose which generated
 * provider role and assigned S3 location belong to the Authentication source.
 */
export function loadSecurityLakeCustomSourceResponse(
  environment: NodeJS.ProcessEnv,
  auditAccountId: string,
): SecurityLakeCustomSourceResponse {
  const responsePath =
    environment[SECURITY_LAKE_CUSTOM_SOURCE_RESPONSE_ENVIRONMENT_VARIABLE];
  if (responsePath === undefined || responsePath.length === 0) {
    throw new Error(
      `${SECURITY_LAKE_CUSTOM_SOURCE_RESPONSE_ENVIRONMENT_VARIABLE} must name the custom-source response file.`,
    );
  }
  if (!isAbsolute(responsePath)) {
    throw new Error(
      `${SECURITY_LAKE_CUSTOM_SOURCE_RESPONSE_ENVIRONMENT_VARIABLE} must be an absolute path.`,
    );
  }

  return parseSecurityLakeCustomSourceResponse(
    readFileSync(responsePath, 'utf8'),
    auditAccountId,
  );
}

/** Reduce the untrusted AWS creation receipt to CDK's narrow destination contract. */
export function parseSecurityLakeCustomSourceResponse(
  contents: string,
  auditAccountId: string,
): SecurityLakeCustomSourceResponse {
  const response = requireJsonObject(
    parseJsonText(contents),
    'custom-source response',
  );
  const source = requireJsonObject(response.source, 'source');
  const provider = requireJsonObject(source.provider, 'source.provider');
  const sourceName = requireExactString(
    source.sourceName,
    CUSTOM_SOURCE_NAME,
    'source.sourceName',
  );
  const sourceVersion = requireExactString(
    source.sourceVersion,
    CUSTOM_SOURCE_VERSION,
    'source.sourceVersion',
  );
  const providerRoleArn = requireNonEmptyString(
    provider.roleArn,
    'source.provider.roleArn',
  );
  const providerRoleName = requireProviderRoleName(
    providerRoleArn,
    auditAccountId,
  );
  const { bucketName, sourcePrefix } = parseSourceLocation(
    requireNonEmptyString(provider.location, 'source.provider.location'),
  );

  return Object.freeze({
    destination: Object.freeze({
      bucketName,
      providerRoleArn,
      providerRoleName,
      sourcePrefix,
    }),
    sourceName,
    sourceVersion,
  });
}

/** Parse untrusted JSON text without claiming a TypeScript shape prematurely. */
function parseJsonText(contents: string): unknown {
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw new Error('custom-source response must contain valid JSON.');
  }
}

/** Require a JSON object before reading any named response fields. */
function requireJsonObject(
  value: unknown,
  fieldName: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${fieldName} must be a JSON object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

/** Require a populated string for an AWS response field. */
function requireNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
  return value;
}

/** Narrow one response field to the exact source contract supported by this app. */
function requireExactString<T extends string>(
  value: unknown,
  expected: T,
  fieldName: string,
): T {
  if (value !== expected) {
    throw new Error(`${fieldName} must equal ${expected}.`);
  }
  return expected;
}

/** Validate provider-role ownership and extract its IAM role name. */
function requireProviderRoleName(roleArn: string, auditAccountId: string): string {
  const match = /^arn:[^:]+:iam::([0-9]{12}):role\/(.+)$/.exec(roleArn);
  if (match === null || match[1] !== auditAccountId || match[2] === undefined) {
    throw new Error('source.provider.roleArn must belong to the audit account.');
  }
  const roleName = match[2].split('/').at(-1);
  if (roleName === undefined || roleName.length === 0) {
    throw new Error('source.provider.roleArn must contain a role name.');
  }
  return roleName;
}

/** Split the assigned S3 URI and reject destinations outside this source version. */
function parseSourceLocation(location: string): {
  readonly bucketName: string;
  readonly sourcePrefix: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(location);
  } catch {
    throw new Error('source.provider.location must be a valid S3 URI.');
  }
  const sourcePrefix = parsed.pathname.slice(1);
  if (
    parsed.protocol !== 's3:'
    || parsed.hostname.length === 0
    || sourcePrefix !== CUSTOM_SOURCE_VERSIONED_PREFIX
  ) {
    throw new Error(
      `source.provider.location must use s3://<bucket>/${CUSTOM_SOURCE_VERSIONED_PREFIX}.`,
    );
  }
  return { bucketName: parsed.hostname, sourcePrefix };
}
