# Audit-account delivery alarms

Status: implementation plan for the audit-account delivery slice of issue #78.
The workload-side producer slice is
[reservation-audit-publish-failure-alarms](./reservation-audit-publish-failure-alarms.md) (#88).

## Goal

Detect audit events that the central audit account accepted but did not deliver
to Security Lake. The workload alarms from #88 cover events that never reached
the bus; these alarms cover the hops after it:

```text
reservation service -> EventBridge bus -> rule -> Firehose -> Security Lake S3
        #88 alarms        FailedInvocations    Throttled   DataFreshness
                          target DLQ           FailedConversion (quarantine)
```

## Current state

- `@movie-platform/audit-ingestion` creates one rule, target DLQ and Firehose
  stream per workload account and exposes `AuditProducerResources.metrics`, but
  deliberately creates no alarms (`docs/plans/audit-ingestion-package.md`).
- `AuditAccountIngestionStack` composes the package and has no alarms or
  notification boundary.
- The legacy demo's `AuditDeliveryFreshnessAlarm` is the only precedent: 300 s
  threshold on a stream with a smaller buffer, no action.

## Decisions

- **Ownership.** A new `AuditDeliveryAlarms` construct in
  `apps/audit-account/lib/` is instantiated by `AuditAccountIngestionStack`.
  The reusable package stays alarm-free; thresholds live in composition and
  are construct props with documented defaults.
- **Per producer account, not aggregate.** Every producer already has an
  isolated rule, DLQ and stream, so its alarms name the affected workload
  account directly. With one configured account an aggregate adds nothing.
- **No composite.** Unlike the six failure reasons in #88, these alarms are
  different failure modes on different hops that trip at different times
  (freshness within minutes, DLQ only after the 24-hour retry window). Each
  alarm notifies directly.
- **Routing.** One unsubscribed, TLS-only SNS topic in the audit account,
  exposed as the `AuditDeliveryAlarmTopicArn` output. Workload and audit
  accounts keep separate topics because alarms cannot target a topic in
  another account without a cross-account topic policy, and the incident
  provider can subscribe to both.
- **Severity** is stated in each alarm description and the runbook. One topic
  is enough until an incident provider maps severities.
- **Missing data is not breaching** for every alarm here. All four AWS service
  metrics are emitted only while there is activity, and absence of ordinary
  traffic is not a delivery failure. End-to-end liveness belongs to the
  synthetic verification in #75.
- **Package change.** Add `failedConversionRecords`
  (`AWS/Firehose` `FailedConversion.Records`) to `AuditIngestionMetrics`.
  Records failing Parquet conversion go to the quarantine prefix, not the
  query dataset, which is an audit gap for investigators.

## Alarms (per producer account)

| Alarm | Metric | Rule | Severity |
| --- | --- | --- | --- |
| Failed invocations | `AWS/Events` `FailedInvocations`, Sum, 1 min | > 0 for 1 period | Critical |
| Target DLQ messages | SQS `ApproximateNumberOfMessagesVisible`, Maximum, 1 min | > 0 for 1 period | Critical |
| Delivery freshness | `AWS/Firehose` `DeliveryToS3.DataFreshness`, Maximum, 1 min | > 900 s for 3 periods | Critical |
| Conversion failures | `AWS/Firehose` `FailedConversion.Records`, Sum, 1 min | > 0 for 1 period | Critical |
| Sustained throttling | `AWS/Firehose` `ThrottledRecords`, Sum, 1 min | > 0 in 3 of 5 periods | Warning |

Threshold reasoning:

- Freshness: the stream buffers up to 300 s, so healthy freshness reaches
  about five minutes. 900 s (three buffer intervals) for three minutes means S3
  delivery is failing. Firehose retries S3 delivery for 24 hours, after which
  records are lost, so this is critical.
- Throttling is a warning: EventBridge retries throttled deliveries for up to
  185 attempts or 24 hours. Loss shows up in the critical failed-invocation and
  DLQ alarms; throttling only predicts it. "3 of 5" ignores single bursts.
- The DLQ alarm stays in `ALARM` while messages remain, so a drained or
  redriven queue is the recovery signal.

## Non-goals

- Grafana panels and synthetic delivery verification (remaining #78 scope, #75).
- Subscribing an incident provider, or deploying.
- Alarms on `InvocationsFailedToBeSentToDlq`: such failures also increment
  `FailedInvocations`, and the runbook explains how to tell them apart.

## Implementation steps

1. Package: add `failedConversionRecords` to `AuditIngestionMetrics` and
   `createProducerMetrics`; rebuild the package.
2. App: add `apps/audit-account/lib/audit-delivery-alarms.ts` with the topic and
   five alarms per producer, and instantiate it in `AuditAccountIngestionStack`
   with an `AuditDeliveryAlarmTopicArn` output.
3. Tests in `apps/audit-account/test/audit-account-ingestion-stack.test.ts`:
   the TLS-only topic and output, exact metric/dimension/threshold/evaluation/
   missing-data contract for each alarm, the topic action on every alarm, and
   one alarm set per configured workload account.
4. Docs: runbook `docs/runbooks/audit-delivery-alarms.md`, runbooks index,
   and the audit-account README.

## Verification

- `npm run build:audit-account-dependencies` and `npm run build:apps`
- `npm run test:cdk:audit-account` and `npm run validate:audit-ingestion`
- `npm run synth:audit-account` (offline, `--no-lookups`)
- `git diff --check`

## AWS resource impact

Synth-only. A later, separately approved deploy of `AuditAccountIngestionStack`
would create 5 CloudWatch alarms per workload account, one SNS topic and its
policy. Standard-resolution alarms cost about USD 0.10 each per month.
