import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import type { DemoCredentials, RunConfig } from './model';

/** The demo web proxy's reservation-service login route. */
export const DEFAULT_LOGIN_PATH = '/audit-demo/reservation/login';

export const RUN_CONFIG_SCHEMA = 'audit-transport-comparison-run/v1' as const;

/** Expected configuration failure, safe to print: messages never echo values. */
export class RunConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RunConfigError';
  }
}

// Interpolated into Athena SQL, so only plain lowercase identifiers are accepted.
const ATHENA_IDENTIFIER = /^[a-z0-9_]{1,255}$/;
const WORKGROUP_NAME = /^[a-zA-Z0-9._-]{1,128}$/;
const CRAWLER_NAME = /^[\w.-]{1,255}$/;
const MAX_ATTEMPTS_PER_OUTCOME = 20;

/** Parse and validate the run file text written by the environments repository. */
export function parseRunConfig(contents: string): RunConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(contents) as unknown;
  } catch {
    throw new RunConfigError('the run file must contain valid JSON');
  }
  const root = object(raw, 'run file');
  if (root.schema !== RUN_CONFIG_SCHEMA) {
    throw new RunConfigError(`run file schema must be ${RUN_CONFIG_SCHEMA}`);
  }

  const attempts = object(root.attempts, 'attempts');
  const legacyStore = object(root.legacyStore, 'legacyStore');
  const securityLakeStore = object(root.securityLakeStore, 'securityLakeStore');
  const deliveryHealth = object(root.deliveryHealth, 'deliveryHealth');
  const pollIntervalSeconds = integer(root.pollIntervalSeconds ?? 30, 'pollIntervalSeconds', 5, 300);
  const timeoutSeconds = integer(root.timeoutSeconds ?? 1200, 'timeoutSeconds', 60, 3600);
  if (pollIntervalSeconds > timeoutSeconds) {
    throw new RunConfigError('pollIntervalSeconds must not exceed timeoutSeconds');
  }
  const accepted = integer(attempts.accepted ?? 3, 'attempts.accepted', 0, MAX_ATTEMPTS_PER_OUTCOME);
  const rejected = integer(attempts.rejected ?? 3, 'attempts.rejected', 0, MAX_ATTEMPTS_PER_OUTCOME);
  if (accepted + rejected === 0) {
    throw new RunConfigError('attempts must request at least one login');
  }

  return Object.freeze({
    endpoint: endpoint(root.endpoint, boolean(root.allowInsecureHttp ?? false, 'allowInsecureHttp')),
    loginPath: matching(root.loginPath ?? DEFAULT_LOGIN_PATH, 'loginPath', /^\/[a-z0-9/_-]{1,200}$/),
    credentialsFile: absolutePath(root.credentialsFile, 'credentialsFile'),
    attempts: Object.freeze({ accepted, rejected }),
    workloadTargetFile: absolutePath(root.workloadTargetFile, 'workloadTargetFile'),
    auditTargetFile: absolutePath(root.auditTargetFile, 'auditTargetFile'),
    legacyStore: Object.freeze({
      workGroup: matching(legacyStore.workGroup, 'legacyStore.workGroup', WORKGROUP_NAME),
      database: matching(legacyStore.database, 'legacyStore.database', ATHENA_IDENTIFIER),
      table: matching(legacyStore.table, 'legacyStore.table', ATHENA_IDENTIFIER),
    }),
    securityLakeStore: Object.freeze({
      workGroup: matching(securityLakeStore.workGroup, 'securityLakeStore.workGroup', WORKGROUP_NAME),
      crawlerName: matching(securityLakeStore.crawlerName, 'securityLakeStore.crawlerName', CRAWLER_NAME),
      refreshCatalog: boolean(securityLakeStore.refreshCatalog ?? false, 'securityLakeStore.refreshCatalog'),
    }),
    deliveryHealth: Object.freeze({
      deadLetterQueueUrl: sqsQueueUrl(deliveryHealth.deadLetterQueueUrl),
      alarmNamePrefix: matching(deliveryHealth.alarmNamePrefix, 'deliveryHealth.alarmNamePrefix', /^[\w./-]{1,200}$/),
    }),
    timeoutSeconds,
    pollIntervalSeconds,
    catalogRefreshDelaySeconds: integer(root.catalogRefreshDelaySeconds ?? 90, 'catalogRefreshDelaySeconds', 0, 1800),
    output: absolutePath(root.output, 'output'),
  });
}

export function loadRunConfig(path: string): RunConfig {
  return parseRunConfig(readPrivateFile(path, 'run file'));
}

/** Read `{"username", "password"}` from an owner-only file; values are never printed. */
export function loadDemoCredentials(path: string): DemoCredentials {
  let raw: unknown;
  try {
    raw = JSON.parse(readPrivateFile(path, 'credentials file')) as unknown;
  } catch (error) {
    if (error instanceof RunConfigError) {
      throw error;
    }
    throw new RunConfigError('the credentials file must contain valid JSON');
  }
  const credentials = object(raw, 'credentials file');
  return Object.freeze({
    username: nonEmptyString(credentials.username, 'credentials username'),
    password: nonEmptyString(credentials.password, 'credentials password'),
  });
}

/** Private inputs must be regular files that only the operator can read. */
function readPrivateFile(path: string, label: string): string {
  if (!isAbsolute(path)) {
    throw new RunConfigError(`the ${label} path must be absolute`);
  }
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    throw new RunConfigError(`the ${label} must exist`);
  }
  if (!metadata.isFile()) {
    throw new RunConfigError(`the ${label} must be a regular file, not a link or directory`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new RunConfigError(`the ${label} must deny all group and other access (chmod 600)`);
  }
  return readFileSync(path, 'utf8');
}

function object(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RunConfigError(`${label} must be a JSON object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RunConfigError(`${label} must be a non-empty string`);
  }
  return value;
}

function matching(value: unknown, label: string, pattern: RegExp): string {
  const text = nonEmptyString(value, label);
  if (!pattern.test(text)) {
    throw new RunConfigError(`${label} has an unsupported format`);
  }
  return text;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RunConfigError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new RunConfigError(`${label} must be true or false`);
  }
  return value;
}

function absolutePath(value: unknown, label: string): string {
  const path = nonEmptyString(value, label);
  if (!isAbsolute(path)) {
    throw new RunConfigError(`${label} must be an absolute path`);
  }
  return path;
}

/**
 * HTTPS by default. Plain HTTP needs `allowInsecureHttp`: the demo ALB is
 * HTTP-only behind an operator prefix list and uses throwaway credentials.
 */
function endpoint(value: unknown, allowInsecureHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(nonEmptyString(value, 'endpoint'));
  } catch (error) {
    if (error instanceof RunConfigError) {
      throw error;
    }
    throw new RunConfigError('endpoint must be an absolute URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowInsecureHttp)) {
    throw new RunConfigError('endpoint must use https unless allowInsecureHttp is true');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new RunConfigError('endpoint must not contain credentials, a query, or a fragment');
  }
  return url;
}

function sqsQueueUrl(value: unknown): string {
  const text = nonEmptyString(value, 'deliveryHealth.deadLetterQueueUrl');
  if (!/^https:\/\/sqs\.[a-z0-9-]+\.amazonaws\.com\/[0-9]{12}\/[\w-]{1,80}$/.test(text)) {
    throw new RunConfigError('deliveryHealth.deadLetterQueueUrl must be an SQS queue URL');
  }
  return text;
}
