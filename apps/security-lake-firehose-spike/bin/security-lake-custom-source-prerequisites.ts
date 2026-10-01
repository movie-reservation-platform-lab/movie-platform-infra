import { App } from 'aws-cdk-lib';
import { loadAuditAccountConfig } from '@movie-platform/audit-account-config';
import { SecurityLakeCustomSourcePrerequisitesStack } from '../lib/security-lake-custom-source-prerequisites-stack';
import { loadSecurityLakePrerequisitesConfig } from '../lib/security-lake-prerequisites-config';

const auditConfig = loadAuditAccountConfig(process.env);
const prerequisitesConfig = loadSecurityLakePrerequisitesConfig(
  process.env,
  auditConfig,
);
const app = new App();

new SecurityLakeCustomSourcePrerequisitesStack(
  app,
  'SecurityLakeCustomSourcePrerequisitesStack',
  {
    env: {
      account: auditConfig.auditAccountId,
      region: auditConfig.region,
    },
    description: 'Disposable Security Lake custom-source crawler prerequisites',
    prerequisitesConfig,
  },
);
