import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { AthenaClient } from '@aws-sdk/client-athena';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { GlueClient } from '@aws-sdk/client-glue';
import { SQSClient } from '@aws-sdk/client-sqs';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { fromIni } from '@aws-sdk/credential-providers';
import { validateAwsAccess, type ValidatedAwsAccess } from '@movie-platform/aws-account-preflight';

import { AthenaAuditStoreReader } from '../adapters/athena-audit-store-reader';
import { legacyLookupQuery, securityLakeLookupQuery } from '../adapters/athena-queries';
import { AwsDeliveryHealthReader } from '../adapters/aws-delivery-health-reader';
import { GlueSecurityLakeCatalog } from '../adapters/glue-security-lake-catalog';
import { HttpLoginClient } from '../adapters/http-login-client';
import { writeNewPrivateFile } from '../adapters/private-files';
import type { Clock } from '../core/ports';
import type { ComparisonDependencies } from '../core/run-comparison';
import type { CliDependencies } from './cli';
import { RunConfigError, loadDemoCredentials, loadRunConfig, type RunConfig } from './run-config';

/**
 * Composition root: the only module that knows which concrete adapter
 * implements each port. Tests replace this whole object.
 */

const SYSTEM_CLOCK: Clock = {
  now: () => new Date(),
  sleep: (milliseconds) => new Promise((done) => setTimeout(done, Math.max(0, milliseconds))),
};

export const PRODUCTION_DEPENDENCIES: CliDependencies = {
  loadRunConfig,
  loadCredentials: loadDemoCredentials,
  // The preflight package reads its target from MOVIE_PLATFORM_AWS_TARGET_FILE.
  validateAccess: (targetFile, environment) =>
    validateAwsAccess({ ...environment, MOVIE_PLATFORM_AWS_TARGET_FILE: targetFile }),
  verifySdkIdentity,
  createComparisonDependencies,
  writeEvidence: (path, contents) => writeNewPrivateFile(path, contents, 'evidence file'),
  // src/cli -> src -> audit-transport-comparison -> automation -> repository root.
  repositoryRoot: resolve(__dirname, '../../../..'),
};

/** SDK clients use only the preflighted profile and config files, never ambient credentials. */
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

/**
 * The preflight proves the identity through the AWS CLI. Prove that the SDK
 * credentials built from the same profile reach the same account, in case the
 * config changed in between.
 */
async function verifySdkIdentity(access: ValidatedAwsAccess, label: string): Promise<void> {
  const identity = await new STSClient(pinnedClientConfig(access)).send(new GetCallerIdentityCommand({}));
  if (identity.Account !== access.target.accountId) {
    throw new RunConfigError(`the SDK credentials for the ${label} profile do not reach the preflighted account`);
  }
}

function createComparisonDependencies(
  config: RunConfig,
  workload: ValidatedAwsAccess,
  audit: ValidatedAwsAccess,
): ComparisonDependencies {
  const auditClientConfig = pinnedClientConfig(audit);
  const catalog = new GlueSecurityLakeCatalog(new GlueClient(auditClientConfig), config.securityLakeStore.crawlerName);

  // Resolve the Security Lake table once and reuse it; forget a failed lookup
  // so the next poll retries instead of repeating a cached rejection.
  let securityLakeTable: Promise<{ database: string; table: string }> | undefined;
  const resolveSecurityLakeTable = () => {
    securityLakeTable ??= catalog.resolveTable().catch((error: unknown) => {
      securityLakeTable = undefined;
      throw error;
    });
    return securityLakeTable;
  };

  return {
    clock: SYSTEM_CLOCK,
    login: new HttpLoginClient(config.loginUrl),
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
    catalog,
    deliveryHealth: new AwsDeliveryHealthReader(
      new SQSClient(auditClientConfig),
      new CloudWatchClient(auditClientConfig),
      config.deliveryHealth.deadLetterQueueUrl,
      config.deliveryHealth.alarmNamePrefix,
    ),
    newRunId: () => randomUUID().slice(0, 8),
  };
}
