# Audit Delivery Alarms

Tracking: [issue #78](https://github.com/movie-reservation-platform-lab/movie-platform-infra/issues/78).
Plan: [audit-delivery-alarms](../plans/audit-delivery-alarms.md).

These alarms cover audit events the central EventBridge bus in the audit account
has **accepted** but not yet delivered to Security Lake. Events that never reach
the bus raise the workload-side [audit publish alarms](./audit-publish-alarms.md).

All alarms live in `AuditAccountIngestionStack`, one set per configured workload
account. The alarm description names the account. They are composition policy,
not part of the reusable `AuditIngestion` package.

## Routing boundary

Alarms publish their `ALARM` transition to one SNS topic, exposed as the
`AuditDeliveryAlarmTopicArn` stack output. The topic denies non-TLS publishing and
has **no subscription**, so nobody is notified until a separately approved
incident-provider integration subscribes it. Meanwhile, watch alarm state in the
audit account's CloudWatch console. This topic is separate from the workload
account's `AuditAlarmTopicArn`; a provider subscribes to both.

## Missing data

Every alarm treats missing data as **not breaching**. EventBridge, Firehose, and
SQS publish these metrics only while there is activity, and no workload traffic
is not a delivery failure. These alarms therefore cannot prove the path is alive;
synthetic end-to-end verification (#75) owns that.

## Alarms

| Alarm | Fires when | Severity | Meaning |
| --- | --- | --- | --- |
| `FailedInvocationsAlarm` | `AWS/Events` `FailedInvocations` > 0 in one minute | Critical | EventBridge gave up delivering to Firehose after its retry policy (185 attempts / 24 h) or could not invoke it at all. |
| `TargetDeadLetterAlarm` | Target DLQ visible messages > 0 | Critical | Failed deliveries are parked in the DLQ (14-day retention). Stays in `ALARM` until the queue is drained. |
| `DeliveryFreshnessAlarm` | `DeliveryToS3.DataFreshness` > 900 s for 3 minutes | Critical | Firehose cannot write to the Security Lake bucket. Records are lost after Firehose's 24-hour S3 retry window. |
| `FailedConversionAlarm` | `FailedConversion.Records` > 0 in one minute | Critical | Records did not match the Parquet conversion schema and went to the quarantine (`-errors/`) prefix, outside the query dataset. |
| `SustainedThrottlingAlarm` | `ThrottledRecords` > 0 in 3 of 5 minutes | Warning | Firehose is throttling. EventBridge retries, so nothing is lost yet; act before it escalates to the critical alarms. |

## First response

- **Failed invocations without a matching new DLQ message**: EventBridge could not
  write to the DLQ either (`InvocationsFailedToBeSentToDlq`), so the bus archive is
  the only remaining copy. Check the DLQ resource policy, then replay from the
  archive before its 7-day retention expires.
- **DLQ messages**: inspect a message's error attributes (`ERROR_CODE`,
  `ERROR_MESSAGE`). Typical causes are the EventBridge delivery role losing
  `firehose:PutRecord*` or the stream being deleted. Fix the cause, then replay
  from the bus archive (7-day retention) or redrive the DLQ.
- **Freshness**: check the Firehose stream's destination error logs and the
  Security Lake provider role's write access to the bucket and prefix.
- **Conversion failures**: inspect quarantined objects under the `-errors/`
  prefix. Usually a producer emitted an event outside the pinned
  `platform-audit/1` schema. Quarantine holds raw, possibly sensitive input;
  do not copy it into tickets.
- **Throttling**: check Firehose Direct Put quotas for the stream and Region, and
  whether one producer is bursting.

Replays and redrives can create duplicate records; consumers deduplicate on
`metadata.uid`.
