import { Duration } from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import type * as sqs from 'aws-cdk-lib/aws-sqs';

/** Delivery controls missing from CDK's L1 Firehose EventBridge target. */
export interface ReliableFirehoseTargetProps {
  readonly deadLetterQueue: sqs.IQueue;
  readonly maxEventAge?: Duration;
  readonly message: events.RuleTargetInput;
  readonly retryAttempts?: number;
}

/** Bind Firehose with explicit retry and target-DLQ behavior. */
export class ReliableFirehoseTarget implements events.IRuleTarget {
  public constructor(
    private readonly stream: firehose.CfnDeliveryStream,
    private readonly props: ReliableFirehoseTargetProps,
  ) {}

  public bind(
    rule: Parameters<events.IRuleTarget['bind']>[0],
  ): events.RuleTargetConfig {
    const role = new iam.Role(this.stream, 'EventBridgeDeliveryRole', {
      assumedBy: new iam.ServicePrincipal('events.amazonaws.com'),
      description: 'Allows EventBridge to deliver audit events to Firehose',
    });
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['firehose:PutRecord', 'firehose:PutRecordBatch'],
      resources: [this.stream.attrArn],
    }));

    this.props.deadLetterQueue.addToResourcePolicy(new iam.PolicyStatement({
      actions: ['sqs:SendMessage'],
      conditions: { ArnEquals: { 'aws:SourceArn': rule.ruleRef.ruleArn } },
      principals: [new iam.ServicePrincipal('events.amazonaws.com')],
      resources: [this.props.deadLetterQueue.queueArn],
    }));

    return {
      arn: this.stream.attrArn,
      deadLetterConfig: { arn: this.props.deadLetterQueue.queueArn },
      input: this.props.message,
      retryPolicy: {
        maximumEventAgeInSeconds: (this.props.maxEventAge ?? Duration.hours(24)).toSeconds(),
        maximumRetryAttempts: this.props.retryAttempts ?? 185,
      },
      role,
      targetResource: this.stream,
    };
  }
}
