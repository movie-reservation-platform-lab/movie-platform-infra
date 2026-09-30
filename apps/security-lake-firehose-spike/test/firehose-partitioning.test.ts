import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { SecurityLakeAuditIngestionStack } from '../lib/security-lake-audit-ingestion-stack';

const TEST_TARGET = { account: '222222222222', region: 'eu-central-1' } as const;
const EVENT_DAY_QUERY = '{eventDay: (.time / 1000 | strftime("%Y%m%d"))}';
const SECURITY_LAKE_PREFIX =
  'ext/MOVIE_AUTH/region=eu-central-1/accountId=333333333333/eventDay=!{partitionKeyFromQuery:eventDay}/';
const FIREHOSE_ERROR_PREFIX =
  'ext/MOVIE_AUTH-errors/!{firehose:error-output-type}/!{timestamp:yyyy/MM/dd/HH}/';

function createTemplate(): Template {
  const app = new App();
  return Template.fromStack(
    new SecurityLakeAuditIngestionStack(
      app,
      'FakeSecurityLakeAuditIngestionStack',
      {
        env: TEST_TARGET,
        sourceConfig: {
          bucketName: 'aws-security-data-lake-eu-central-1-example',
          providerRoleArn:
            'arn:aws:iam::222222222222:role/AmazonSecurityLake-Provider-MOVIE_AUTH-eu-central-1',
          providerRoleName: 'AmazonSecurityLake-Provider-MOVIE_AUTH-eu-central-1',
          sourceAccountId: '333333333333',
          sourceLocation:
            's3://aws-security-data-lake-eu-central-1-example/ext/MOVIE_AUTH/',
          sourcePrefix: 'ext/MOVIE_AUTH/',
        },
      },
    ),
  );
}

describe('Firehose partitioning', () => {
  let template: Template;

  beforeEach(() => {
    template = createTemplate();
  });

  /**
   * Proves that synthesis preserves the Security Lake partitioning contract
   * without coupling the test to unrelated Firehose properties.
   */
  it('routes valid records by source Region, account, and UTC event day', () => {
    template.hasResourceProperties(
      'AWS::KinesisFirehose::DeliveryStream',
      {
        ExtendedS3DestinationConfiguration: {
          DynamicPartitioningConfiguration: {
            Enabled: true,
          },
          ProcessingConfiguration: {
            Enabled: true,
            Processors: Match.arrayWith([
              Match.objectLike({
                Type: 'MetadataExtraction',
                Parameters: Match.arrayWith([
                  Match.objectLike({
                    ParameterName: 'JsonParsingEngine',
                    ParameterValue: 'JQ-1.6',
                  }),
                  Match.objectLike({
                    ParameterName: 'MetadataExtractionQuery',
                    ParameterValue: EVENT_DAY_QUERY,
                  }),
                ]),
              }),
            ]),
          },
          Prefix: SECURITY_LAKE_PREFIX,
        },
      },
    );
  });

  it('routes conversion failures outside the valid partition hierarchy', () => {
    template.hasResourceProperties(
      'AWS::KinesisFirehose::DeliveryStream',
      {
        ExtendedS3DestinationConfiguration: Match.objectLike({
          ErrorOutputPrefix: FIREHOSE_ERROR_PREFIX,
        }),
      },
    );
  });

  it('uses the Security Lake provider role for delivery and schema conversion', () => {
    const providerRoleArn =
      'arn:aws:iam::222222222222:role/AmazonSecurityLake-Provider-MOVIE_AUTH-eu-central-1';

    template.hasResourceProperties(
      'AWS::KinesisFirehose::DeliveryStream',
      {
        ExtendedS3DestinationConfiguration: Match.objectLike({
          RoleARN: providerRoleArn,
          DataFormatConversionConfiguration: Match.objectLike({
            SchemaConfiguration: Match.objectLike({ RoleARN: providerRoleArn }),
          }),
        }),
      },
    );
  });
});
