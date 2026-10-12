import { DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';

import { AwsDeliveryHealthReader } from '../../src/adapters/aws-delivery-health-reader';
import { fakeSdkClient } from '../support/fake-sdk-client';

describe('AwsDeliveryHealthReader', () => {
  it('sums visible and in-flight DLQ messages and lists delivery alarms in ALARM', async () => {
    const sqs = fakeSdkClient([[GetQueueAttributesCommand, [{ Attributes: { ApproximateNumberOfMessages: '1', ApproximateNumberOfMessagesNotVisible: '2' } }]]]);
    const cloudWatch = fakeSdkClient([[DescribeAlarmsCommand, [{ MetricAlarms: [{ AlarmName: 'a' }] }]]]);

    await expect(new AwsDeliveryHealthReader(sqs as never, cloudWatch as never, 'https://sqs/q', 'prefix').read())
      .resolves.toEqual({ deadLetterMessages: 3, alarmsInAlarm: ['a'] });
    expect(cloudWatch.sent[0]?.input).toEqual({ AlarmNamePrefix: 'prefix', StateValue: 'ALARM' });
  });

  it('fails instead of reporting zero when SQS returns no counts', async () => {
    const sqs = fakeSdkClient([[GetQueueAttributesCommand, [{ Attributes: {} }]]]);

    await expect(new AwsDeliveryHealthReader(sqs as never, fakeSdkClient([]) as never, 'https://sqs/q', 'prefix').read())
      .rejects.toThrow('no message counts');
  });
});
