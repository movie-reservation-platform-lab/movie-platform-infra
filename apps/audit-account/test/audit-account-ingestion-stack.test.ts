import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import type { AuditAccountConfig } from '@movie-platform/audit-account-config';
import { AuditAccountIngestionStack } from '../lib/audit-account-ingestion-stack';
import type { SecurityLakeCustomSourceResponse } from '../lib/security-lake-custom-source-response';

const TEST_CONFIG = {
  managementAccountId: '111111111111',
  auditAccountId: '222222222222',
  workloadAccountIds: ['333333333333'],
  region: 'eu-central-1',
} as const satisfies AuditAccountConfig;

const TEST_CUSTOM_SOURCE = {
  destination: {
    bucketName: 'aws-security-data-lake-eu-central-1-example',
    providerRoleArn:
      'arn:aws:iam::222222222222:role/AmazonSecurityLake-Provider-MOVIEAUTH-eu-central-1',
    providerRoleName:
      'AmazonSecurityLake-Provider-MOVIEAUTH-eu-central-1',
    sourcePrefix: 'ext/MOVIE_AUTH/1.0/',
  },
  sourceName: 'MOVIE_AUTH',
  sourceVersion: '1.0',
} as const satisfies SecurityLakeCustomSourceResponse;

function createIngestionTemplate(): Template {
  const stack = new AuditAccountIngestionStack(
    new App(),
    'AuditAccountIngestionStack',
    {
      config: TEST_CONFIG,
      customSource: TEST_CUSTOM_SOURCE,
      env: {
        account: TEST_CONFIG.auditAccountId,
        region: TEST_CONFIG.region,
      },
    },
  );
  return Template.fromStack(stack);
}

describe('AuditAccountIngestionStack', () => {
  it('allows only configured workload accounts to put events on the central bus', () => {
    const ingestionTemplate = createIngestionTemplate();

    ingestionTemplate.hasResourceProperties('AWS::Events::EventBusPolicy', {
      Statement: Match.objectLike({
        Action: 'events:PutEvents',
        Principal: {
          AWS: {
            'Fn::Join': [
              '',
              [
                'arn:',
                { Ref: 'AWS::Partition' },
                `:iam::${TEST_CONFIG.workloadAccountIds[0]}:root`,
              ],
            ],
          },
        },
        Sid: 'cdk-AllowConfiguredWorkloadAccounts',
      }),
      StatementId: 'cdk-AllowConfiguredWorkloadAccounts',
    });
  });

  it('exports the central event bus contract consumed by workload composition', () => {
    const ingestionTemplate = createIngestionTemplate();

    ingestionTemplate.hasOutput("AuditEventBusArn", {
      Description: Match.stringLikeRegexp('.+'),
      Export: {
        Name: 'MoviePlatformAuditEventBusArn',
      },
      Value: Match.anyValue(),
    });
  });

  it('composes one reusable ingestion path for every configured workload account', () => {
    const ingestionTemplate = createIngestionTemplate();

    ingestionTemplate.resourceCountIs('AWS::Events::Rule', 1);
    ingestionTemplate.resourceCountIs('AWS::KinesisFirehose::DeliveryStream', 1);
    ingestionTemplate.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({ account: ['333333333333'] }),
    });
  });
});
