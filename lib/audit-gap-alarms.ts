import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

// Bounded SDK failure reasons; the service pre-creates one zero series per reason.
const AUDIT_PUBLISH_FAILURE_REASONS = [
  'timeout',
  'aborted',
  'rejected',
  'throttled',
  'configuration',
  'unavailable',
] as const;
// Log-derived metric: CloudWatch-style name, unlike the OTel snake_case names.
const UNAUDITED_SUCCESSFUL_LOGINS_METRIC = 'UnauditedSuccessfulLogins';

interface AuditGapAlarmsProps {
  /** CloudWatch namespace the ADOT EMF exporter writes application metrics to. */
  readonly applicationMetricsNamespace: string;
  readonly environmentName: string;
  readonly reservationServiceLogGroup: logs.ILogGroup;
}

/**
 * Authentication fails open, so these alarms are the only signal of an
 * unaudited login.
 *
 * Policy lives in workload composition, not in the reusable
 * AuditIngestion construct. The topic is provider-neutral and deliberately has
 * no subscription yet; incident grouping belongs to the future provider.
 */
export class AuditGapAlarms extends Construct {
  readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: AuditGapAlarmsProps) {
    super(scope, id);
    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', { enforceSSL: true });
    const alarmAction = new cloudwatchActions.SnsAction(this.alarmTopic);

    // One alarm per reason keeps the cause visible in the console; only the
    // composite notifies, so one outage produces one notification.
    const primaryAuditPublishFailureAlarms = AUDIT_PUBLISH_FAILURE_REASONS.map((failureReason) => {
      const alarmIdReason = failureReason[0].toUpperCase() + failureReason.slice(1);
      return new cloudwatch.Alarm(this, `PrimaryPublish${alarmIdReason}Alarm`, {
        alarmDescription: `Primary audit publisher failed with reason "${failureReason}": a login may be ` +
          'unaudited. Missing data means the metric pipeline is broken and is treated as breaching.',
        metric: new cloudwatch.Metric({
          namespace: props.applicationMetricsNamespace,
          metricName: 'audit_publish_total',
          dimensionsMap: {
            ServiceName: 'movie-reservation-service',
            Environment: props.environmentName,
            audit_publisher_role: 'primary',
            result: 'failed',
            failure_reason: failureReason,
          },
          statistic: cloudwatch.Stats.SUM,
          period: cdk.Duration.minutes(1),
        }),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      });
    });
    new cloudwatch.CompositeAlarm(this, 'PrimaryAuditPublishFailureAlarm', {
      alarmDescription: 'Primary audit publisher failed: logins may be unaudited. The child alarm in ' +
        'ALARM names the failure reason; see docs/operations/audit-publish-alarms.md.',
      alarmRule: cloudwatch.AlarmRule.anyOf(...primaryAuditPublishFailureAlarms),
    }).addAlarmAction(alarmAction);

    // A metric filter metric has no dimensions, so the environment is part of
    // the namespace to keep environments that share an account apart.
    const unauditedSuccessfulLogins = new logs.MetricFilter(this, 'UnauditedSuccessfulLoginFilter', {
      logGroup: props.reservationServiceLogGroup,
      filterPattern: logs.FilterPattern.all(
        logs.FilterPattern.stringValue('$.event', '=', 'audit.emit.failed'),
        logs.FilterPattern.numberValue('$.auth_status_id', '=', 1),
      ),
      metricNamespace: `MoviePlatform/${props.environmentName}/audit-gaps`,
      metricName: UNAUDITED_SUCCESSFUL_LOGINS_METRIC,
      metricValue: '1',
    });
    const unauditedSuccessfulLoginsMetric = unauditedSuccessfulLogins.metric({
      period: cdk.Duration.minutes(1),
      statistic: cloudwatch.Stats.SUM,
    });


    new cloudwatch.Alarm(this, 'UnauditedSuccessfulLoginAlarm', {
      alarmDescription: 'A successful login was not audited: the audit event was not accepted. ' +
        'Find it via audit.emit.failed with auth_status_id=1; see docs/operations/audit-publish-alarms.md.',
      metric: unauditedSuccessfulLoginsMetric,
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      // No matching log line is the healthy state; counter alarms guard telemetry loss.
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(alarmAction);
  }
}
