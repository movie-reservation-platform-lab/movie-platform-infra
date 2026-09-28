import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export const AUDIT_ACCOUNT_REGION = 'eu-central-1' as const;
export const AUDIT_ACCOUNT_CONFIG_ENVIRONMENT_VARIABLE =
  'MOVIE_PLATFORM_AUDIT_ACCOUNT_CONFIG_FILE' as const;

const CONFIG_KEYS = [
  'managementAccountId',
  'auditAccountId',
  'workloadAccountIds',
  'region',
] as const;
const AWS_ACCOUNT_ID_PATTERN = /^[0-9]{12}$/;

/** Expected configuration failure safe to show at the CLI boundary. */
export class AuditAccountConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AuditAccountConfigError';
  }
}

/** Account roles and Region selected by the audit-account composition root. */
export interface AuditAccountConfig {
  readonly managementAccountId: string;
  readonly auditAccountId: string;
  readonly workloadAccountIds: readonly string[];
  readonly region: typeof AUDIT_ACCOUNT_REGION;
}

/**
 * Parse an audit-account topology document into validated runtime configuration.
 *
 * Rejects malformed JSON, unexpected fields, invalid account identifiers,
 * overlapping account roles, and unsupported Regions.
 */
export function parseAuditAccountConfigJson(contents: string): AuditAccountConfig {
  const rawJson = parseRawContent(contents);
  const parsedJson = requireJsonObject(rawJson);

  const allRequiredKeysPresent = CONFIG_KEYS.every((key) => key in parsedJson);
  if (!allRequiredKeysPresent) {
    throw new AuditAccountConfigError('some of the required keys are missing!');
  }
  const allowedKeys = new Set<string>(CONFIG_KEYS);
  const containsUnknownKey = Object.keys(parsedJson).some(
    (key) => !allowedKeys.has(key),
  );
  if (containsUnknownKey) {
    throw new AuditAccountConfigError(
      'Config contains extra keys outside of the required ones.',
    );
  }

  const managementAccountId = requireAccountId(
    parsedJson.managementAccountId,
    'managementAccountId',
  );
  const auditAccountId = requireAccountId(
    parsedJson.auditAccountId,
    'auditAccountId',
  );
  const workloadAccountIds = requireWorkloadAccountIds(parsedJson.workloadAccountIds);
  const region = requireRegion(parsedJson.region);

  requireDistinctAccountRoles(
    managementAccountId,
    auditAccountId,
    workloadAccountIds,
  );

  const auditAccountConfig = {
    managementAccountId,
    auditAccountId,
    workloadAccountIds,
    region,
  };
  return Object.freeze(auditAccountConfig);
}

/** Load and validate audit-account configuration from an explicit absolute path. */
export function loadAuditAccountConfig(
  environment: NodeJS.ProcessEnv,
): AuditAccountConfig {
  const configFilepath = environment[AUDIT_ACCOUNT_CONFIG_ENVIRONMENT_VARIABLE];
  if (configFilepath === undefined || configFilepath.length === 0) {
    throw new AuditAccountConfigError(
      `${AUDIT_ACCOUNT_CONFIG_ENVIRONMENT_VARIABLE} must name the config file.`,
    );
  }
  if (!isAbsolute(configFilepath)) {
    throw new AuditAccountConfigError(
      `${AUDIT_ACCOUNT_CONFIG_ENVIRONMENT_VARIABLE} must be an absolute path.`,
    );
  }

  const configFileContent = readFileSync(configFilepath, 'utf8');
  return parseAuditAccountConfigJson(configFileContent);
}

/** Parse JSON text while translating syntax errors into a safe domain diagnostic. */
function parseRawContent(rawContent: string): unknown {
  try {
    return JSON.parse(rawContent) as unknown;
  } catch {
    throw new AuditAccountConfigError('Unable to read raw json content.');
  }
}

/** Require a non-null, non-array JSON object before reading named fields. */
function requireJsonObject(
  unvalidatedJson: unknown,
): Readonly<Record<string, unknown>> {
  if (
    unvalidatedJson === null
    || typeof unvalidatedJson !== 'object'
    || Array.isArray(unvalidatedJson)
  ) {
    throw new AuditAccountConfigError(
      'audit-account config must contain a json object.',
    );
  }
  return unvalidatedJson as Readonly<Record<string, unknown>>;
}

/** Require one field to contain a syntactically valid 12-digit AWS account ID. */
function requireAccountId(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !AWS_ACCOUNT_ID_PATTERN.test(value)) {
    throw new AuditAccountConfigError(
      `${fieldName} must be a valid 12-digit AWS account ID.`,
    );
  }

  return value;
}

/** Require the workload field to be an array containing only valid account IDs. */
function requireWorkloadAccountIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new AuditAccountConfigError(`${value} account ids is not an array`);
  }
  if (value.length === 0) {
    throw new AuditAccountConfigError(
      'Workload accounts cannot be an empty array.',
    );
  }
  if (
    !value.every(
      (item) => typeof item === 'string' && AWS_ACCOUNT_ID_PATTERN.test(item),
    )
  ) {
    throw new AuditAccountConfigError(
      `${value} - some of the elements are not valid accounts`,
    );
  }

  return value;
}

/** Require the one AWS Region currently supported by the audit-account demo. */
function requireRegion(value: unknown): typeof AUDIT_ACCOUNT_REGION {
  if (value !== AUDIT_ACCOUNT_REGION) {
    throw new AuditAccountConfigError('trying to use an unsupported region');
  }
  return value;
}

/** Require management, audit, and workload account roles to remain unambiguous. */
function requireDistinctAccountRoles(
  managementAccountId: string,
  auditAccountId: string,
  workloadAccountIds: readonly string[],
): void {
  if (managementAccountId === auditAccountId) {
    throw new AuditAccountConfigError('audit and management accounts must differ');
  }
  if (
    workloadAccountIds.some(
      (workloadAccountId) =>
      workloadAccountId === auditAccountId
        || workloadAccountId === managementAccountId,
    )
  ) {
    throw new AuditAccountConfigError(
      'None of the workload accounts can be a management or audit account',
    );
  }
  if (workloadAccountIds.length !== new Set(workloadAccountIds).size) {
    throw new AuditAccountConfigError('Workload accounts contain duplicates');
  }
}
