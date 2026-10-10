# Audit Publish Alarms

Tracking: [issue #88](https://github.com/movie-reservation-platform-lab/movie-platform-infra/issues/88).
Plan: [reservation-audit-publish-failure-alarms](../plans/reservation-audit-publish-failure-alarms.md).

## Why these alarms are critical

Authentication fails open: when the reservation service cannot get an audit
event accepted, login still returns its normal `200` or `401` without receipt
fields. The service logs `audit.emit.failed` and counts the failure. These
alarms are therefore the **only** signal that an authenticated login may be
missing from the audit trail. Treat every `ALARM` transition as critical.

All alarms live in the workload account's `MovieReservationWorkloadStack`. They
are composition policy, not part of the reusable `AuditIngestion` construct.

## Routing boundary

Alarms publish their `ALARM` transition to one SNS topic, exposed as the
`AuditAlarmTopicArn` stack output. The topic denies non-TLS publishing and has
**no subscription**: until a separately approved incident-provider integration
subscribes it, nobody is notified. Watch alarm state in the CloudWatch console
meanwhile. `OK` and `INSUFFICIENT_DATA` transitions are not routed yet.

## Primary publish failure alarms

Six child alarms, one per bounded failure reason, on `audit_publish_total` in the
`MoviePlatform/<environment>/applications` namespace with dimensions
`ServiceName=movie-reservation-service`, `Environment`, `audit_publisher_role=primary`,
`result=failed`, and `failure_reason`. Each fires when the one-minute `Sum` is
greater than zero.

The children have no actions. One composite alarm, `ALARM` when **any** child is
in `ALARM`, is the only one that notifies, so one outage that trips several
reasons sends one notification. Open the composite's child alarms to see which
reason is firing. A second reason that starts while the composite is already in
`ALARM` sends no new notification; incident grouping stays the incident tool's
job.

They select the publisher **role**, not the transport, so they keep working after
the one-variable rollback to `AUDIT_PUBLISHER=stdout`. Failures of the
best-effort `comparison` publisher do not alarm.

**Missing data is breaching.** The service creates zero series for every reason
at startup, so no datapoint means the producer, collector, or EMF path is
broken, and audit gaps would be invisible. Check the reservation-service and
ADOT log groups first.

| `failure_reason` | Likely cause | First response |
| --- | --- | --- |
| `timeout` | `PutEvents` exceeded `AUDIT_PUBLISH_TIMEOUT_MS` | Check EventBridge latency and the task's network path (VPC endpoint/NAT). |
| `aborted` | The request was cancelled before publication finished | Correlate with client disconnects and task shutdowns. |
| `rejected` | The event bus refused the entry | Check the central bus resource policy and the producer authorization in the audit account. |
| `throttled` | EventBridge throttling | Check `PutEvents` quotas for the workload account and Region. |
| `configuration` | Invalid bus ARN, Region, or permission | Compare the task's `AUDIT_EVENT_BUS_ARN` with the audit-account output and the task-role policy. |
| `unavailable` | Transport or local publisher error | Check service logs for `audit.emit.failed`; consider the `stdout` rollback. |

Use `audit.emit.failed` log entries (`failure_reason`, `auth_status_id`, and
correlation IDs) to find affected logins. The transport (`audit_publisher`)
is available in AMP, not as a CloudWatch dimension.

## Unaudited successful-login alarm

A CloudWatch Logs metric filter on the reservation-service log group matches
`event = "audit.emit.failed"` together with `auth_status_id = 1`. Its alarm fires
on any match. Missing data is not breaching, because no matching entries is
normal; the counter alarms above guard telemetry liveness.

## Deferred: publish-latency warning

A p99 warning at 80% of `AUDIT_PUBLISH_TIMEOUT_MS` was planned but deferred. The
pinned ADOT `awsemf` exporter publishes explicit-bucket histograms only as
cumulative statistic sets, so CloudWatch cannot compute a per-period p99 for
`audit_publish_duration_ms`. Publications that hit the hard timeout still raise
the `timeout` alarm.
