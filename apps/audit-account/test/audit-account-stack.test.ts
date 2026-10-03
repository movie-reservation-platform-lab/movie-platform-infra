import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import type { AuditAccountConfig } from '@movie-platform/audit-account-config';
import { AuditAccountStack } from '../lib/audit-account-stack';

const TEST_CONFIG = {
  managementAccountId: '111111111111',
  auditAccountId: '222222222222',
  workloadAccountIds: ['333333333333'],
  region: 'eu-central-1',
} as const satisfies AuditAccountConfig;

function createFoundationTemplate(): Template {
  const stack = new AuditAccountStack(new App(), 'AuditAccountStack', {
    config: TEST_CONFIG,
    env: {
      account: TEST_CONFIG.auditAccountId,
      region: TEST_CONFIG.region,
    },
  });
  return Template.fromStack(stack);
}

describe('AuditAccountStack', () => {
  it('configures bounded regional storage and the custom-source handoff', () => {
    const foundationTemplate = createFoundationTemplate();

    foundationTemplate.hasResourceProperties('AWS::SecurityLake::DataLake', {
      EncryptionConfiguration: { KmsKeyId: 'S3_MANAGED_KEY' },
      LifecycleConfiguration: { Expiration: { Days: 30 } },
      MetaStoreManagerRoleArn: Match.anyValue(),
    });
    foundationTemplate.hasOutput('CustomSourceCrawlerRoleArn', {
      Description: 'Crawler role passed to CreateCustomLogSource.',
      Value: Match.anyValue(),
    });
  });

  it('enables CloudTrail management events only for the configured audit and workload accounts', () => {
    const foundationTemplate = createFoundationTemplate();

    foundationTemplate.hasResourceProperties(
      'AWS::SecurityLake::AwsLogSource',
      {
        Accounts: [
          TEST_CONFIG.auditAccountId,
          ...TEST_CONFIG.workloadAccountIds,
        ],
        DataLakeArn: Match.anyValue(),
        SourceName: 'CLOUD_TRAIL_MGMT',
        SourceVersion: '2.0',
      },
    );
  });
});
