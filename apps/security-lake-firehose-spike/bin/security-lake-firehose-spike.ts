import { App } from 'aws-cdk-lib';
import { loadAuditAccountConfig } from '@movie-platform/audit-account-config';
import { loadSecurityLakeSourceConfig } from '../lib/security-lake-source-config';
import { SecurityLakeAuditIngestionStack } from '../lib/security-lake-audit-ingestion-stack';

const auditConfig = loadAuditAccountConfig(process.env);
const sourceConfig = loadSecurityLakeSourceConfig(process.env, auditConfig);
const app = new App();

new SecurityLakeAuditIngestionStack(app, 'SecurityLakeAuditIngestionStack', {
  env: {
    account: auditConfig.auditAccountId,
    region: auditConfig.region,
  },
  description: 'Disposable Firehose-to-Security-Lake feasibility checkpoint',
  sourceConfig,
});
