import { App, Duration, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AuditIngestion, type AuditIngestionProps } from '../src';

const TEST_PROPS = {
  destination: {
    bucketName: 'aws-security-data-lake-eu-central-1-example',
    providerRoleArn:
      'arn:aws:iam::222222222222:role/AmazonSecurityLake-Provider-MOVIE_AUTH-eu-central-1',
    providerRoleName: 'AmazonSecurityLake-Provider-MOVIE_AUTH-eu-central-1',
    sourcePrefix: 'ext/MOVIE_AUTH/1.0/',
  },
  producers: [
    { workloadAccountId: '333333333333' },
    { workloadAccountId: '444444444444' },
  ],
} as const satisfies AuditIngestionProps;

function createTemplate(props: AuditIngestionProps = TEST_PROPS): Template {
  const stack = new Stack(new App(), 'AuditIngestionFixture', {
    env: { account: '222222222222', region: 'eu-central-1' },
  });
  new AuditIngestion(stack, 'AuditIngestion', props);
  return Template.fromStack(stack);
}

describe('AuditIngestion', () => {
  it('creates one detail-only routing path per configured workload account', () => {
    const template = createTemplate();

    template.resourceCountIs('AWS::Events::EventBus', 1);
    template.resourceCountIs('AWS::Events::Archive', 1);
    template.resourceCountIs('AWS::Events::Rule', 2);
    template.resourceCountIs('AWS::KinesisFirehose::DeliveryStream', 2);
    template.resourceCountIs('AWS::SQS::Queue', 2);
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        account: ['333333333333'],
        detail: { envelope_version: ['1'] },
        'detail-type': ['ocsf.authentication.v1'],
        source: Match.arrayWith(['movie-platform.reservation-service.audit']),
      },
      Targets: Match.arrayWith([
        Match.objectLike({
          DeadLetterConfig: { Arn: Match.anyValue() },
          InputPath: '$.detail.event',
          RetryPolicy: {
            MaximumEventAgeInSeconds: 86400,
            MaximumRetryAttempts: 185,
          },
        }),
      ]),
    });
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({ account: ['444444444444'] }),
    });
    template.hasResourceProperties('AWS::Events::Archive', {
      EventPattern: Match.objectLike({
        account: ['333333333333', '444444444444'],
      }),
      RetentionDays: 7,
    });
    template.hasResourceProperties('AWS::SQS::Queue', {
      MessageRetentionPeriod: 1_209_600,
      SqsManagedSseEnabled: true,
    });
  });

  it('partitions each producer stream and keeps quarantine outside valid data', () => {
    const template = createTemplate();

    template.hasResourceProperties('AWS::KinesisFirehose::DeliveryStream', {
      DeliveryStreamEncryptionConfigurationInput: { KeyType: 'AWS_OWNED_CMK' },
      ExtendedS3DestinationConfiguration: Match.objectLike({
        ErrorOutputPrefix:
          'ext/MOVIE_AUTH/1.0-errors/!{firehose:error-output-type}/!{timestamp:yyyy/MM/dd/HH}/',
        Prefix:
          'ext/MOVIE_AUTH/1.0/region=eu-central-1/accountId=333333333333/eventDay=!{partitionKeyFromQuery:eventDay}/',
      }),
    });
    template.hasResourceProperties('AWS::KinesisFirehose::DeliveryStream', {
      ExtendedS3DestinationConfiguration: Match.objectLike({
        Prefix:
          'ext/MOVIE_AUTH/1.0/region=eu-central-1/accountId=444444444444/eventDay=!{partitionKeyFromQuery:eventDay}/',
      }),
    });
    const quarantinePolicies = Object.values(
      template.findResources('AWS::IAM::Policy'),
    ).filter((resource) =>
      JSON.stringify(resource).includes('movie-platform-audit-quarantine-write'),
    );
    expect(quarantinePolicies).toHaveLength(1);
    expect(quarantinePolicies[0]).toMatchObject({
      Properties: {
        PolicyDocument: {
          Statement: [
            expect.objectContaining({ Action: 's3:PutObject', Effect: 'Allow' }),
          ],
        },
        Roles: ['AmazonSecurityLake-Provider-MOVIE_AUTH-eu-central-1'],
      },
    });
    expect(JSON.stringify(quarantinePolicies[0])).toContain(
      'aws-security-data-lake-eu-central-1-example/ext/MOVIE_AUTH/1.0-errors/*',
    );
  });

  it('uses separate Glue and Lake Formation schema access', () => {
    const template = createTemplate();

    template.resourceCountIs('AWS::LakeFormation::PrincipalPermissions', 2);
    template.hasResourceProperties('AWS::Glue::Table', {
      TableInput: {
        Name: 'platform_audit_v1_authentication_conversion',
        StorageDescriptor: Match.not(Match.objectLike({ Location: Match.anyValue() })),
      },
    });
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Principal: { Service: 'firehose.amazonaws.com' } }),
        ]),
      },
    });
  });

  it('keeps each producer\'s logical IDs when other accounts are removed or reordered', () => {
    const producerLogicalIds = (template: Template, accountId: string): string[] =>
      Object.keys(template.toJSON().Resources as Record<string, unknown>)
        .filter((logicalId) => logicalId.includes(`Producer${accountId}`))
        .sort();
    const original = producerLogicalIds(createTemplate(), '444444444444');

    expect(original).not.toHaveLength(0);
    expect(producerLogicalIds(createTemplate({
      ...TEST_PROPS,
      producers: [{ workloadAccountId: '444444444444' }],
    }), '444444444444')).toEqual(original);
    expect(producerLogicalIds(createTemplate({
      ...TEST_PROPS,
      producers: [...TEST_PROPS.producers].reverse(),
    }), '444444444444')).toEqual(original);
  });

  it('tags producer resources with their workload account', () => {
    const template = createTemplate();
    const accountTag = { Key: 'movie-platform:workload-account', Value: '444444444444' };

    template.hasResourceProperties('AWS::SQS::Queue', {
      Tags: Match.arrayWith([accountTag]),
    });
    template.hasResourceProperties('AWS::KinesisFirehose::DeliveryStream', {
      Tags: Match.arrayWith([accountTag]),
    });
  });

  it('buffers for 300 seconds unless the caller chooses a bounded interval', () => {
    const bufferingHints = (template: Template): unknown =>
      Object.values(template.findResources('AWS::KinesisFirehose::DeliveryStream'))
        .map((resource) => resource.Properties.ExtendedS3DestinationConfiguration.BufferingHints)[0];

    expect(bufferingHints(createTemplate())).toEqual({ IntervalInSeconds: 300, SizeInMBs: 64 });
    expect(bufferingHints(createTemplate({ ...TEST_PROPS, bufferInterval: Duration.seconds(60) })))
      .toEqual({ IntervalInSeconds: 60, SizeInMBs: 64 });
    expect(() => createTemplate({ ...TEST_PROPS, bufferInterval: Duration.seconds(59) }))
      .toThrow('bufferInterval must be between 60 and 900 seconds');
    expect(() => createTemplate({ ...TEST_PROPS, bufferInterval: Duration.seconds(901) }))
      .toThrow('bufferInterval must be between 60 and 900 seconds');
  });

  it('rejects missing, duplicate, and malformed producer accounts', () => {
    expect(() => createTemplate({ ...TEST_PROPS, producers: [] })).toThrow(
      'requires at least one producer',
    );
    expect(() => createTemplate({
      ...TEST_PROPS,
      producers: [
        { workloadAccountId: '333333333333' },
        { workloadAccountId: '333333333333' },
      ],
    })).toThrow('must be unique 12-digit values');
    expect(() => createTemplate({
      ...TEST_PROPS,
      producers: [{ workloadAccountId: 'not-an-account' }],
    })).toThrow('must be unique 12-digit values');
  });
});
