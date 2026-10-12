import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';

import { AthenaClient } from '@aws-sdk/client-athena';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { fromIni } from '@aws-sdk/credential-providers';
import { GlueClient } from '@aws-sdk/client-glue';
import { SQSClient } from '@aws-sdk/client-sqs';
import {
  PreflightFailure,
  validateAwsAccess,
  type ValidatedAwsAccess,
} from '@movie-platform/aws-account-preflight';

import { legacyLookupQuery, securityLakeLookupQuery } from './athena-queries';
import { AthenaAuditStoreReader, AwsDeliveryHealthReader, GlueSecurityLakeCatalog } from './aws-adapters';
import { describeError, runComparison, type ComparisonDependencies, type ComparisonContext } from './comparison';
import { HttpLoginClient } from './login-client';
import type { Clock, ComparisonResult, RunConfig } from './model';
import { renderSummary } from './report';
import { RunConfigError, loadDemoCredentials, loadRunConfig } from './run-config';

const USAGE = `Usage: npm run compare:audit-transports -- --run-file /absolute/run.json

Sends controlled demo logins, then polls the Security Lake and legacy audit
stores for the returned audit event IDs. Writes versioned JSON evidence to the
run file's "output" path and prints a summary. The only AWS mutation is an
optional, single Security Lake crawler start (securityLakeStore.refreshCatalog).

Exit codes: 0 passed, 1 comparison failed, 2 invalid input or preflight failure.
`;

export interface CliStreams {
  stdout(text: string): void;
  stderr(text: string): void;
}

/** Seams for tests: everything that touches files, AWS, the network, or time. */
export interface CliDependencies {
  loadRunConfig(path: string): RunConfig;
  loadCredentials(path: string): ComparisonContext['credentials'];
  validateAccess(targetFile: string, environment: NodeJS.ProcessEnv): ValidatedAwsAccess;
  createComparisonDependencies(config: RunConfig, workload: ValidatedAwsAccess, audit: ValidatedAwsAccess): ComparisonDependencies;
  writeResult(path: string, result: ComparisonResult): void;
}

const PROCESS_STREAMS: CliStreams = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export async function runCli(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  streams: CliStreams = PROCESS_STREAMS,
  dependencies: CliDependencies = PRODUCTION_DEPENDENCIES,
): Promise<number> {
  let config: RunConfig;
  let context: ComparisonContext;
  let comparisonDependencies: ComparisonDependencies;
  try {
    const { values } = parseArgs({
      args: [...arguments_],
      options: { 'run-file': { type: 'string' }, help: { type: 'boolean' } },
      strict: true,
    });
    if (values.help === true) {
      streams.stdout(USAGE);
      return 0;
    }
    if (values['run-file'] === undefined) {
      throw new RunConfigError('--run-file is required');
    }
    config = dependencies.loadRunConfig(values['run-file']);
    const credentials = dependencies.loadCredentials(config.credentialsFile);
    const workload = dependencies.validateAccess(config.workloadTargetFile, environment);
    const audit = dependencies.validateAccess(config.auditTargetFile, environment);
    if (workload.target.accountId === audit.target.accountId) {
      throw new RunConfigError('the workload and audit targets must be different accounts');
    }
    context = { credentials, workloadAccountId: workload.target.accountId, region: workload.target.region };
    comparisonDependencies = dependencies.createComparisonDependencies(config, workload, audit);
  } catch (error) {
    if (error instanceof RunConfigError || error instanceof PreflightFailure || error instanceof TypeError) {
      streams.stderr(`audit transport comparison: ${describeError(error)}\n${USAGE}`);
      return 2;
    }
    throw error;
  }

  const result = await runComparison(config, context, comparisonDependencies);
  dependencies.writeResult(config.output, result);
  streams.stdout(renderSummary(result));
  streams.stdout(`Evidence written to the run file's output path.\n`);
  return result.status === 'passed' ? 0 : 1;
}

const SYSTEM_CLOCK: Clock = {
  now: () => new Date(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds))),
};

/** Clients use only the preflighted profile; ambient credentials are never used. */
function pinnedClientConfig(access: ValidatedAwsAccess) {
  return {
    region: access.target.region,
    credentials: fromIni({
      profile: access.target.profile,
      filepath: access.configFiles.credentialsFilepath,
      configFilepath: access.configFiles.configFilepath,
      clientConfig: { region: access.target.region },
      ignoreCache: true,
    }),
  };
}

function createComparisonDependencies(
  config: RunConfig,
  workload: ValidatedAwsAccess,
  audit: ValidatedAwsAccess,
): ComparisonDependencies {
  const auditClientConfig = pinnedClientConfig(audit);
  const catalog = new GlueSecurityLakeCatalog(new GlueClient(auditClientConfig), config.securityLakeStore.crawlerName);
  let securityLakeTable: Promise<{ database: string; table: string }> | undefined;
  const resolveSecurityLakeTable = () => (securityLakeTable ??= catalog.resolveTable());

  return {
    clock: SYSTEM_CLOCK,
    login: new HttpLoginClient(new URL(config.loginPath, config.endpoint)),
    stores: {
      legacy: new AthenaAuditStoreReader(
        new AthenaClient(pinnedClientConfig(workload)),
        config.legacyStore.workGroup,
        async (ids, window) => legacyLookupQuery(config.legacyStore.database, config.legacyStore.table, ids, window),
        SYSTEM_CLOCK,
      ),
      securityLake: new AthenaAuditStoreReader(
        new AthenaClient(auditClientConfig),
        config.securityLakeStore.workGroup,
        async (ids, window) => {
          const { database, table } = await resolveSecurityLakeTable();
          return securityLakeLookupQuery(database, table, ids, window);
        },
        SYSTEM_CLOCK,
      ),
    },
    securityLakeCatalog: catalog,
    deliveryHealth: new AwsDeliveryHealthReader(
      new SQSClient(auditClientConfig),
      new CloudWatchClient(auditClientConfig),
      config.deliveryHealth.deadLetterQueueUrl,
      config.deliveryHealth.alarmNamePrefix,
    ),
    newRunId: () => randomUUID().slice(0, 8),
  };
}

const PRODUCTION_DEPENDENCIES: CliDependencies = {
  loadRunConfig,
  loadCredentials: loadDemoCredentials,
  // The preflight package reads its target from MOVIE_PLATFORM_AWS_TARGET_FILE.
  validateAccess: (targetFile, environment) =>
    validateAwsAccess({ ...environment, MOVIE_PLATFORM_AWS_TARGET_FILE: targetFile }),
  createComparisonDependencies,
  writeResult: (path, result) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  },
};
