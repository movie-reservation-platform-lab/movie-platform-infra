import { type CloudWatchClient, DescribeAlarmsCommand, StateValue } from '@aws-sdk/client-cloudwatch';
import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';

import type { DeliveryHealth, DeliveryHealthReader } from '../core/ports';
import type { SendClient } from './sdk-client';

/** Reads the audit-account target DLQ depth and the delivery alarms in ALARM. */
export class AwsDeliveryHealthReader implements DeliveryHealthReader {
  public constructor(
    private readonly sqs: SendClient<SQSClient>,
    private readonly cloudWatch: SendClient<CloudWatchClient>,
    private readonly queueUrl: string,
    private readonly alarmNamePrefix: string,
  ) {}

  public async read(): Promise<DeliveryHealth> {
    const { Attributes } = await this.sqs.send(new GetQueueAttributesCommand({
      QueueUrl: this.queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }));
    const visible = Attributes?.ApproximateNumberOfMessages;
    const inFlight = Attributes?.ApproximateNumberOfMessagesNotVisible;
    if (visible === undefined || inFlight === undefined) {
      throw new Error('SQS returned no message counts for the target DLQ');
    }
    // Delivery alarms are few (five per producer), so one page is enough.
    const { MetricAlarms } = await this.cloudWatch.send(new DescribeAlarmsCommand({
      AlarmNamePrefix: this.alarmNamePrefix,
      StateValue: StateValue.ALARM,
    }));
    return {
      deadLetterMessages: Number(visible) + Number(inFlight),
      alarmsInAlarm: (MetricAlarms ?? []).flatMap(({ AlarmName }) => (AlarmName === undefined ? [] : [AlarmName])),
    };
  }
}
