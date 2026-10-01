import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { SecurityLakeAuditIngestionStack } from '../lib/security-lake-audit-ingestion-stack';

const TEST_TARGET = { account: '222222222222', region: 'eu-central-1' } as const;
const EVENT_DAY_QUERY = '{eventDay: (.time / 1000 | strftime("%Y%m%d"))}';
const SECURITY_LAKE_PREFIX =
  'ext/MOVIE_AUTH/1.0/region=eu-central-1/accountId=333333333333/eventDay=!{partitionKeyFromQuery:eventDay}/';
const FIREHOSE_ERROR_PREFIX =
  'ext/MOVIE_AUTH/1.0-errors/!{firehose:error-output-type}/!{timestamp:yyyy/MM/dd/HH}/';
const FIREHOSE_ERROR_OBJECT_PATH =
  'aws-security-data-lake-eu-central-1-example/ext/MOVIE_AUTH/1.0-errors/*';

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
            's3://aws-security-data-lake-eu-central-1-example/ext/MOVIE_AUTH/1.0/',
          sourcePrefix: 'ext/MOVIE_AUTH/1.0/',
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

  it('keeps Security Lake delivery separate from conversion-schema access', () => {
    const providerRoleArn =
      'arn:aws:iam::222222222222:role/AmazonSecurityLake-Provider-MOVIE_AUTH-eu-central-1';
    const streams = Object.values(
      template.findResources('AWS::KinesisFirehose::DeliveryStream'),
    );

    expect(streams).toHaveLength(1);
    expect(streams[0]).toHaveProperty(
      'Properties.ExtendedS3DestinationConfiguration.RoleARN',
      providerRoleArn,
    );
    expect(streams[0]).toHaveProperty(
      'Properties.ExtendedS3DestinationConfiguration.DataFormatConversionConfiguration.SchemaConfiguration.RoleARN',
      {
        'Fn::GetAtt': [expect.stringMatching(/^ConversionSchemaRole/), 'Arn'],
      },
    );
    expect(streams[0]).not.toHaveProperty(
      'Properties.ExtendedS3DestinationConfiguration.CloudWatchLoggingOptions',
    );

    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Principal: { Service: 'firehose.amazonaws.com' },
          }),
        ]),
      },
      Policies: Match.arrayWith([
        Match.objectLike({
          PolicyDocument: {
            Statement: Match.arrayWith([
              Match.objectLike({
                Action: Match.arrayWith([
                  'glue:GetTable',
                  'glue:GetTableVersion',
                  'glue:GetTableVersions',
                ]),
              }),
            ]),
          },
        }),
      ]),
    });
    const providerPolicies = Object.values(
      template.findResources('AWS::IAM::Policy'),
    );
    expect(providerPolicies).toHaveLength(1);
    expect(providerPolicies[0]).toMatchObject({
      Properties: {
        PolicyDocument: {
          Statement: [
            {
              Action: 's3:PutObject',
              Effect: 'Allow',
            },
          ],
        },
        Roles: ['AmazonSecurityLake-Provider-MOVIE_AUTH-eu-central-1'],
      },
    });
    expect(JSON.stringify(providerPolicies[0])).toContain(
      FIREHOSE_ERROR_OBJECT_PATH,
    );
    template.resourceCountIs('AWS::Logs::LogGroup', 0);
    template.resourceCountIs('AWS::Logs::LogStream', 0);
  });

  it('keeps the conversion schema detached from the governed destination', () => {
    const tables = Object.values(template.findResources('AWS::Glue::Table'));

    expect(tables).toHaveLength(1);
    expect(tables[0]).not.toHaveProperty(
      'Properties.TableInput.StorageDescriptor.Location',
    );
  });

  it('grants required access before Firehose', () => {
    const permissions = template.findResources(
      'AWS::LakeFormation::PrincipalPermissions',
    );
    const streams = Object.values(
      template.findResources('AWS::KinesisFirehose::DeliveryStream'),
    );

    expect(Object.values(permissions)).toHaveLength(2);
    expect(Object.values(permissions)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Properties: expect.objectContaining({
            Permissions: ['DESCRIBE'],
            Resource: { Database: expect.any(Object) },
          }),
        }),
        expect.objectContaining({
          Properties: expect.objectContaining({
            Permissions: ['DESCRIBE'],
            Resource: { Table: expect.any(Object) },
          }),
        }),
      ]),
    );
    expect(streams).toHaveLength(1);
    expect(streams[0]).toHaveProperty(
      'DependsOn',
      expect.arrayContaining([
        ...Object.keys(permissions),
        expect.stringMatching(/^ProviderErrorOutputPolicy/),
      ]),
    );
  });
});
