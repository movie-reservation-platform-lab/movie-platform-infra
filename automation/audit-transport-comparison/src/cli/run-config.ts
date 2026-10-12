import { isAbsolute } from 'node:path';

import { ATHENA_IDENTIFIER } from '../core/identifiers';
import type { ComparisonSettings, DemoCredentials } from '../core/settings';
import { readPrivateFile } from '../adapters/private-files';

/**
 * The run file: untrusted JSON written by the private environments repository.
 * Parsing turns it into a typed, validated `RunConfig`; error messages name
 * the field, never its value.
 */

export const RUN_CONFIG_SCHEMA = 'audit-transport-comparison-run/v1' as const;

/** Values used when the run file omits an optional field (documented in the README). */
export const RUN_CONFIG_DEFAULTS = Object.freeze({
  /** The demo web proxy's reservation-service login route. */
  loginPath: '/audit-demo/reservation/login',
  allowInsecureHttp: false,
  attempts: Object.freeze({ accepted: 3, rejected: 3 }),
  timeoutSeconds: 1200,
  pollIntervalSeconds: 30,
  refreshCatalog: false,
  catalogRefreshDelaySeconds: 90,
});

export class RunConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RunConfigError';
  }
}

export interface RunConfig {
  /** Endpoint plus login path; always on the endpoint's origin. */
  readonly loginUrl: URL;
  readonly credentialsFile: string;
  /** `aws-account-preflight` target files for the two accounts. */
  readonly workloadTargetFile: string;
  readonly auditTargetFile: string;
  /** Athena location of the legacy FireLens -> Firehose -> S3 table (workload account). */
  readonly legacyStore: { readonly workGroup: string; readonly database: string; readonly table: string };
  /** Security Lake custom source (audit account), located through its Glue crawler. */
  readonly securityLakeStore: { readonly workGroup: string; readonly crawlerName: string };
  readonly deliveryHealth: { readonly deadLetterQueueUrl: string; readonly alarmNamePrefix: string };
  readonly settings: ComparisonSettings;
  /** Where the evidence file is created; must not exist yet. */
  readonly output: string;
}

const WORKGROUP_NAME = /^[a-zA-Z0-9._-]{1,128}$/;
const CRAWLER_NAME = /^[\w.-]{1,255}$/;
const ALARM_NAME_PREFIX = /^[\w./-]{1,200}$/;
const LOGIN_PATH = /^\/[a-z0-9_-][a-z0-9/_-]{0,199}$/;
const SQS_QUEUE_URL = /^https:\/\/sqs\.([a-z]{2}-[a-z]+-[0-9])\.amazonaws\.com\/([0-9]{12})\/[\w-]{1,80}$/;
const MAX_ATTEMPTS_PER_OUTCOME = 20;

export function loadRunConfig(path: string): RunConfig {
  return parseRunConfig(readPrivateFile(path, 'run file'));
}

export function parseRunConfig(contents: string): RunConfig {
  const root = requireObject(parseJson(contents, 'run file'), 'run file');
  if (root.schema !== RUN_CONFIG_SCHEMA) {
    throw new RunConfigError(`run file schema must be ${RUN_CONFIG_SCHEMA}`);
  }
  const legacyStore = requireObject(root.legacyStore, 'legacyStore');
  const securityLakeStore = requireObject(root.securityLakeStore, 'securityLakeStore');
  const deliveryHealth = requireObject(root.deliveryHealth, 'deliveryHealth');

  return Object.freeze({
    loginUrl: requireLoginUrl(root),
    credentialsFile: requireAbsolutePath(root.credentialsFile, 'credentialsFile'),
    workloadTargetFile: requireAbsolutePath(root.workloadTargetFile, 'workloadTargetFile'),
    auditTargetFile: requireAbsolutePath(root.auditTargetFile, 'auditTargetFile'),
    legacyStore: Object.freeze({
      workGroup: requireMatch(legacyStore.workGroup, 'legacyStore.workGroup', WORKGROUP_NAME),
      database: requireMatch(legacyStore.database, 'legacyStore.database', ATHENA_IDENTIFIER),
      table: requireMatch(legacyStore.table, 'legacyStore.table', ATHENA_IDENTIFIER),
    }),
    securityLakeStore: Object.freeze({
      workGroup: requireMatch(securityLakeStore.workGroup, 'securityLakeStore.workGroup', WORKGROUP_NAME),
      crawlerName: requireMatch(securityLakeStore.crawlerName, 'securityLakeStore.crawlerName', CRAWLER_NAME),
    }),
    deliveryHealth: Object.freeze({
      deadLetterQueueUrl: requireMatch(deliveryHealth.deadLetterQueueUrl, 'deliveryHealth.deadLetterQueueUrl', SQS_QUEUE_URL),
      alarmNamePrefix: requireMatch(deliveryHealth.alarmNamePrefix, 'deliveryHealth.alarmNamePrefix', ALARM_NAME_PREFIX),
    }),
    settings: requireSettings(root, securityLakeStore),
    output: requireAbsolutePath(root.output, 'output'),
  });
}

/** Account and Region encoded in an SQS queue URL, for checking it against the audit target. */
export function queueUrlLocation(queueUrl: string): { region: string; accountId: string } {
  const match = SQS_QUEUE_URL.exec(queueUrl);
  if (match === null) {
    throw new RunConfigError('deliveryHealth.deadLetterQueueUrl must be an SQS queue URL');
  }
  return { region: match[1], accountId: match[2] };
}

/** Read `{"username", "password"}` from an owner-only file; the values are never printed. */
export function loadDemoCredentials(path: string): DemoCredentials {
  const credentials = requireObject(parseJson(readPrivateFile(path, 'credentials file'), 'credentials file'), 'credentials file');
  return Object.freeze({
    username: requireString(credentials.username, 'credentials username'),
    password: requireString(credentials.password, 'credentials password'),
  });
}

function requireSettings(root: Readonly<Record<string, unknown>>, securityLakeStore: Readonly<Record<string, unknown>>): ComparisonSettings {
  const defaults = RUN_CONFIG_DEFAULTS;
  const attempts = requireObject(root.attempts ?? defaults.attempts, 'attempts');
  const accepted = requireInteger(attempts.accepted ?? defaults.attempts.accepted, 'attempts.accepted', 0, MAX_ATTEMPTS_PER_OUTCOME);
  const rejected = requireInteger(attempts.rejected ?? defaults.attempts.rejected, 'attempts.rejected', 0, MAX_ATTEMPTS_PER_OUTCOME);
  if (accepted + rejected === 0) {
    throw new RunConfigError('attempts must request at least one login');
  }
  const timeoutSeconds = requireInteger(root.timeoutSeconds ?? defaults.timeoutSeconds, 'timeoutSeconds', 60, 3600);
  const pollIntervalSeconds = requireInteger(root.pollIntervalSeconds ?? defaults.pollIntervalSeconds, 'pollIntervalSeconds', 5, 300);
  if (pollIntervalSeconds > timeoutSeconds) {
    throw new RunConfigError('pollIntervalSeconds must not exceed timeoutSeconds');
  }
  return Object.freeze({
    attempts: Object.freeze({ accepted, rejected }),
    timeoutSeconds,
    pollIntervalSeconds,
    refreshCatalog: requireBoolean(securityLakeStore.refreshCatalog ?? defaults.refreshCatalog, 'securityLakeStore.refreshCatalog'),
    catalogRefreshDelaySeconds: requireInteger(
      root.catalogRefreshDelaySeconds ?? defaults.catalogRefreshDelaySeconds,
      'catalogRefreshDelaySeconds',
      0,
      1800,
    ),
  });
}

/**
 * HTTPS by default; plain HTTP needs `allowInsecureHttp` because the demo ALB
 * is HTTP-only behind an operator prefix list and uses throwaway credentials.
 * The login path cannot move the request to another host.
 */
function requireLoginUrl(root: Readonly<Record<string, unknown>>): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(requireString(root.endpoint, 'endpoint'));
  } catch (error) {
    throw error instanceof RunConfigError ? error : new RunConfigError('endpoint must be an absolute URL');
  }
  const allowInsecureHttp = requireBoolean(root.allowInsecureHttp ?? RUN_CONFIG_DEFAULTS.allowInsecureHttp, 'allowInsecureHttp');
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && allowInsecureHttp)) {
    throw new RunConfigError('endpoint must use https unless allowInsecureHttp is true');
  }
  if (endpoint.username !== '' || endpoint.password !== '' || endpoint.search !== '' || endpoint.hash !== '') {
    throw new RunConfigError('endpoint must not contain credentials, a query, or a fragment');
  }
  const loginUrl = new URL(requireMatch(root.loginPath ?? RUN_CONFIG_DEFAULTS.loginPath, 'loginPath', LOGIN_PATH), endpoint);
  if (loginUrl.origin !== endpoint.origin) {
    throw new RunConfigError('loginPath must stay on the endpoint origin');
  }
  return loginUrl;
}

function parseJson(contents: string, label: string): unknown {
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw new RunConfigError(`the ${label} must contain valid JSON`);
  }
}

function requireObject(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RunConfigError(`${label} must be a JSON object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RunConfigError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireMatch(value: unknown, label: string, pattern: RegExp): string {
  const text = requireString(value, label);
  if (!pattern.test(text)) {
    throw new RunConfigError(`${label} has an unsupported format`);
  }
  return text;
}

function requireInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RunConfigError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new RunConfigError(`${label} must be true or false`);
  }
  return value;
}

function requireAbsolutePath(value: unknown, label: string): string {
  const path = requireString(value, label);
  if (!isAbsolute(path)) {
    throw new RunConfigError(`${label} must be an absolute path`);
  }
  return path;
}
