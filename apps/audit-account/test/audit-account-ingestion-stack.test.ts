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

function createIngestionTemplate(config: AuditAccountConfig = TEST_CONFIG): Template {
  const stack = new AuditAccountIngestionStack(
    new App(),
    'AuditAccountIngestionStack',
    {
      config,
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

    ingestionTemplate.hasOutput('AuditEventBusArn', {
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

  describe('delivery alarms', () => {
    const topicAction = [{ Ref: Match.stringLikeRegexp('^AuditDeliveryAlarmsAlarmTopic') }];

    function alarmsMatching(template: Template, logicalIdFragment: string): Record<string, { Properties: Record<string, unknown> }> {
      const alarms = template.findResources('AWS::CloudWatch::Alarm');
      return Object.fromEntries(
        Object.entries(alarms).filter(([logicalId]) => logicalId.includes(logicalIdFragment)),
      ) as Record<string, { Properties: Record<string, unknown> }>;
    }

    it('routes to one unsubscribed TLS-only topic exposed as an output', () => {
      const ingestionTemplate = createIngestionTemplate();

      ingestionTemplate.resourceCountIs('AWS::SNS::Topic', 1);
      ingestionTemplate.resourceCountIs('AWS::SNS::Subscription', 0);
      ingestionTemplate.hasResourceProperties('AWS::SNS::TopicPolicy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([Match.objectLike({
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
            Effect: 'Deny',
          })]),
        }),
      });
      ingestionTemplate.hasOutput('AuditDeliveryAlarmTopicArn', {
        Value: { Ref: Match.stringLikeRegexp('^AuditDeliveryAlarmsAlarmTopic') },
      });
    });

    it('alarms on permanent EventBridge failures and DLQ messages', () => {
      const ingestionTemplate = createIngestionTemplate();

      ingestionTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmActions: topicAction,
        ComparisonOperator: 'GreaterThanThreshold',
        Dimensions: Match.arrayWith([
          Match.objectLike({ Name: 'EventBusName' }),
          Match.objectLike({ Name: 'RuleName' }),
        ]),
        EvaluationPeriods: 1,
        MetricName: 'FailedInvocations',
        Namespace: 'AWS/Events',
        Period: 60,
        Statistic: 'Sum',
        Threshold: 0,
        TreatMissingData: 'notBreaching',
      });
      ingestionTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmActions: topicAction,
        ComparisonOperator: 'GreaterThanThreshold',
        Dimensions: [{
          Name: 'QueueName',
          Value: { 'Fn::GetAtt': [Match.stringLikeRegexp('TargetDeadLetterQueue'), 'QueueName'] },
        }],
        EvaluationPeriods: 1,
        MetricName: 'ApproximateNumberOfMessagesVisible',
        Namespace: 'AWS/SQS',
        Period: 60,
        Statistic: 'Maximum',
        Threshold: 0,
        TreatMissingData: 'notBreaching',
      });
    });

    it('alarms on stale delivery, conversion failures, and sustained throttling', () => {
      const ingestionTemplate = createIngestionTemplate();
      const streamDimension = [{
        Name: 'DeliveryStreamName',
        Value: { Ref: Match.stringLikeRegexp('DeliveryStream') },
      }];

      ingestionTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmActions: topicAction,
        ComparisonOperator: 'GreaterThanThreshold',
        Dimensions: streamDimension,
        EvaluationPeriods: 3,
        MetricName: 'DeliveryToS3.DataFreshness',
        Namespace: 'AWS/Firehose',
        Period: 60,
        Statistic: 'Maximum',
        Threshold: 900,
        TreatMissingData: 'notBreaching',
      });
      ingestionTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmActions: topicAction,
        ComparisonOperator: 'GreaterThanThreshold',
        Dimensions: streamDimension,
        EvaluationPeriods: 1,
        MetricName: 'FailedConversion.Records',
        Namespace: 'AWS/Firehose',
        Period: 60,
        Statistic: 'Sum',
        Threshold: 0,
        TreatMissingData: 'notBreaching',
      });
      ingestionTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmActions: topicAction,
        ComparisonOperator: 'GreaterThanThreshold',
        DatapointsToAlarm: 3,
        Dimensions: streamDimension,
        EvaluationPeriods: 5,
        MetricName: 'ThrottledRecords',
        Namespace: 'AWS/Firehose',
        Period: 60,
        Statistic: 'Sum',
        Threshold: 0,
        TreatMissingData: 'notBreaching',
      });
    });

    it('creates one alarm set per configured workload account, each notifying the topic', () => {
      const ingestionTemplate = createIngestionTemplate({
        ...TEST_CONFIG,
        workloadAccountIds: ['333333333333', '444444444444'],
      });

      ingestionTemplate.resourceCountIs('AWS::CloudWatch::Alarm', 10);
      for (const [producer, accountId] of [['Producer1', '333333333333'], ['Producer2', '444444444444']]) {
        const producerAlarms = Object.values(alarmsMatching(ingestionTemplate, `AuditDeliveryAlarms${producer}`));
        expect(producerAlarms).toHaveLength(5);
        for (const { Properties } of producerAlarms) {
          expect(Properties.AlarmDescription).toContain(accountId);
          expect(Properties.AlarmActions).toEqual([{ Ref: expect.stringMatching(/^AuditDeliveryAlarmsAlarmTopic/) }]);
        }
      }
    });
  });
});
