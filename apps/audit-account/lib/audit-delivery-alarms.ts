import { Duration } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import type { AuditProducerResources } from '@movie-platform/audit-ingestion';
import { Construct } from 'constructs';

const RUNBOOK = 'docs/runbooks/audit-delivery-alarms.md';

export interface AuditDeliveryAlarmsProps {
  /** Per-account ingestion paths whose metrics the alarms watch. */
  readonly producers: readonly AuditProducerResources[];
  /**
   * Oldest undelivered record age that means S3 delivery is failing. Defaults
   * to 15 minutes: three of the stream's 300-second buffer intervals.
   */
  readonly deliveryFreshnessThreshold?: Duration;
}

/**
 * Delivery alarms for audit events the central bus accepted but did not land
 * in Security Lake, one set per workload account.
 *
 * Thresholds are composition policy, so they live here rather than in the
 * reusable AuditIngestion package. Every alarm treats missing data as not
 * breaching: these AWS metrics exist only while there is traffic, and
 * end-to-end liveness belongs to synthetic verification (#75).
 */
export class AuditDeliveryAlarms extends Construct {
  readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: AuditDeliveryAlarmsProps) {
    super(scope, id);
    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', { enforceSSL: true });
    const alarmAction = new cloudwatchActions.SnsAction(this.alarmTopic);
    const freshnessThreshold = props.deliveryFreshnessThreshold ?? Duration.minutes(15);
    const oneMinute = Duration.minutes(1);

    props.producers.forEach(({ metrics, workloadAccountId }, index) => {
      // Same scope naming as the package, so alarm IDs line up with Producer<n> resources.
      // TODO(#90): key by workloadAccountId together with the package; position-based
      // IDs replace alarms whenever an account is removed or reordered.
      const producerScope = new Construct(this, `Producer${index + 1}`);
      const alarmProps = {
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      };
      const alarms = [
        new cloudwatch.Alarm(producerScope, 'FailedInvocationsAlarm', {
          ...alarmProps,
          alarmDescription: `Critical: EventBridge permanently failed to deliver audit events from ` +
            `${workloadAccountId} to Firehose. See ${RUNBOOK}.`,
          metric: metrics.failedInvocations.with({ period: oneMinute }),
          threshold: 0,
          evaluationPeriods: 1,
        }),
        new cloudwatch.Alarm(producerScope, 'TargetDeadLetterAlarm', {
          ...alarmProps,
          alarmDescription: `Critical: undelivered audit events from ${workloadAccountId} are ` +
            `waiting in the target DLQ. See ${RUNBOOK}.`,
          metric: metrics.targetDeadLetterMessages.with({
            period: oneMinute,
            statistic: cloudwatch.Stats.MAXIMUM,
          }),
          threshold: 0,
          evaluationPeriods: 1,
        }),
        new cloudwatch.Alarm(producerScope, 'DeliveryFreshnessAlarm', {
          ...alarmProps,
          alarmDescription: `Critical: Firehose has not delivered audit records from ` +
            `${workloadAccountId} to Security Lake for over ${freshnessThreshold.toSeconds()} s. ` +
            `See ${RUNBOOK}.`,
          metric: metrics.deliveryFreshness.with({ period: oneMinute }),
          threshold: freshnessThreshold.toSeconds(),
          evaluationPeriods: 3,
        }),
        new cloudwatch.Alarm(producerScope, 'FailedConversionAlarm', {
          ...alarmProps,
          alarmDescription: `Critical: audit records from ${workloadAccountId} failed Parquet ` +
            `conversion and were quarantined outside the query dataset. See ${RUNBOOK}.`,
          metric: metrics.failedConversionRecords.with({ period: oneMinute }),
          threshold: 0,
          evaluationPeriods: 1,
        }),
        // Warning only: EventBridge retries throttled deliveries, and actual
        // loss raises the failed-invocation and DLQ alarms. 3 of 5 ignores bursts.
        new cloudwatch.Alarm(producerScope, 'SustainedThrottlingAlarm', {
          ...alarmProps,
          alarmDescription: `Warning: Firehose is throttling audit records from ` +
            `${workloadAccountId}; sustained throttling precedes delivery failure. See ${RUNBOOK}.`,
          metric: metrics.throttledRecords.with({ period: oneMinute }),
          threshold: 0,
          evaluationPeriods: 5,
          datapointsToAlarm: 3,
        }),
      ];
      alarms.forEach((alarm) => alarm.addAlarmAction(alarmAction));
    });
  }
}
