import { App } from 'aws-cdk-lib';
import { loadAuditAccountConfig } from '@movie-platform/audit-account-config';
import { AuditAccountIngestionStack } from '../lib/audit-account-ingestion-stack';
import { loadSecurityLakeCustomSourceResponse } from '../lib/security-lake-custom-source-response';

const config = loadAuditAccountConfig(process.env);
const customSource = loadSecurityLakeCustomSourceResponse(
  process.env,
  config.auditAccountId,
);
const app = new App();

new AuditAccountIngestionStack(app, 'AuditAccountIngestionStack', {
  config,
  customSource,
  env: {
    account: config.auditAccountId,
    region: config.region,
  },
  description: 'Central Authentication audit ingestion for the Movie Reservation Platform Lab',
});
