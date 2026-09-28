import { App } from 'aws-cdk-lib';
import { loadAuditAccountConfig } from '@movie-platform/audit-account-config';
import { AuditAccountStack } from '../lib/audit-account-stack';

const config = loadAuditAccountConfig(process.env);
const app = new App();

new AuditAccountStack(app, 'AuditAccountStack', {
  env: {
    account: config.auditAccountId,
    region: config.region,
  },
  description: 'Dedicated audit-account foundation for the Movie Reservation Platform Lab',
});
