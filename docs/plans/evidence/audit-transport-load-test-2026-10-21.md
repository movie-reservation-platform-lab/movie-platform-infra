# Audit transport load test evidence

Status: both audit transports delivered every event under a stepped load of up
to 25 logins per second. No login went unaudited, no event was lost or
duplicated, and no delivery control fired. The test did not find a capacity
limit.

Do not add account IDs, role ARNs, bucket, stream or queue names, endpoints,
credentials, raw audit events, or private evidence paths to this file.

This follows the healthy-path
[comparison of 2026-10-15](audit-transport-comparison-2026-10-15.md), which used
six sequential logins. It answers a different question: does each transport
keep its guarantees under sustained concurrent load?

## Questions

1. Does every login still return an audit receipt (EventBridge acceptance), or
   does load produce unaudited logins?
2. Does every receipted event reach **both** stores exactly once?
3. How long does each transport take to land an event in S3 under load?
4. Do the request path, the publishers, or the delivery controls (Firehose
   throttling, target DLQ, delivery alarms) show strain?

## Method

- Date: 2026-10-21, 09:50:28–10:01:28 UTC
- Deployment: the same six-image release and workload template that the
  2026-10-15 comparison used. Both transports were active: EventBridge to the
  audit account (primary) and the stdout/FireLens mirror (comparison).
- Run ID: `lt1021a`
- Load: open loop. Requests were sent at fixed times regardless of earlier
  responses, so a slow server could not lower the offered load. Steps:

  | Step | Rate | Duration | Logins |
  | --- | ---: | ---: | ---: |
  | 1 | 1/s | 120 s | 120 |
  | 2 | 5/s | 180 s | 900 |
  | 3 | 10/s | 180 s | 1,800 |
  | 4 | 25/s | 180 s | 4,500 |
  | Total | | 11 min | 7,320 |

- Requests: rejected logins only (a fixed wrong password) through the
  restricted HTTP ALB and the web proxy to reservation-service. Both transports
  handle accepted and rejected logins identically, and the run never handled
  the demo password. Abort rule: more than 5% 5xx or transport errors per step.
- Reconciliation key: every request carried a run-specific `X-Correlation-Id`
  prefix, stored as OCSF `metadata.correlation_uid`. One Athena query per store
  selected the run's events by that prefix. It returned each `metadata.uid`, its
  copy count, and the S3 object write time (`$file_modified_time`). The client
  compared those with the `audit_event_id` receipts.
- Instruments: a single-file, standard-library Python load generator and a
  reconciliation script, run from the operator's laptop. They were one-off and
  are not committed here. See "Follow-up".
- Server-side sources: reservation-service `audit_publish_total` and
  `audit_publish_duration_ms`, ALB metrics, Firehose metrics on both streams,
  the audit target DLQ, the audit delivery alarms, and ECS Container Insights.
- Task: one Fargate task, 2 vCPU / 4 GiB, shared by eight containers. In
  CPU units: reservation-service 384, web proxy 128, FireLens router 128.

## Results

### Request path and publication

| Measure | Result |
| --- | --- |
| HTTP responses | 7,320 / 7,320 `401`, no 5xx, no transport errors |
| Responses with an audit receipt | 7,320 / 7,320 (0 unaudited logins) |
| Primary (EventBridge) publishes accepted | 7,320, every failure reason 0 |
| Comparison (stdout) publishes accepted | 7,320, every failure reason 0 |
| Slowest primary publish (task lifetime) | 138 ms |
| Slowest comparison publish (task lifetime) | 7.9 ms |
| ALB target response time | p50 about 16 ms in every minute; max 0.32 s |
| Task CPU | about 90 of 2,048 units idle, peak 219 at 25/s |
| Task memory | 465 to 516 MiB of 4 GiB |

The publish-duration series are cumulative per task, so they bound the maximum
but do not give per-step percentiles.

The client measured p50 70 ms, p95 0.78 s, p99 4.4 s and max 10.2 s. These
tails do **not** come from the service. 386 of the 387 requests slower than
500 ms fall in three stalls on the client side (one choppy period of about 16 s
and two of about 5 s). Their latencies are spread evenly from 0.5 to 5.5 s,
which is what queuing behind a pause looks like. The ALB saw no target
response above 0.32 s, no 5xx, and no rejected or failed connections. The
stalls were therefore between the load generator and the ALB. This run cannot
say exactly where; there was no packet capture.

### Delivery

| Measure | EventBridge to Security Lake | FireLens to legacy S3 |
| --- | ---: | ---: |
| Events found | 7,320 / 7,320 | 7,320 / 7,320 |
| Missing | 0 | 0 |
| Events with duplicate copies | 0 | 0 |
| Events without a receipt | 0 | 0 |
| Firehose records in / delivered / throttled | 7,320 / 7,320 / 0 | 7,320 / 7,320 / 0 |
| Delay, login to S3 object write: p50 | 54 s | 31 s |
| p95 | 74 s | 59 s |
| p99 | 81 s | 65 s |
| max | 89 s | 69 s |

The target DLQ stayed empty. All five audit delivery alarms stayed `OK` with
no state change.

A first reconciliation about 50 s after the last login found 7,237 (Security
Lake) and 7,272 (legacy) events. The missing IDs were the run's final events,
still inside the 60-second Firehose buffers. A second check four minutes later
found all of them. Reconcile only after the buffer interval plus margin.

The delays measure **delivery to S3**: Firehose buffering plus, for Security
Lake, the cross-account hop and Parquet conversion. They do not include catalog
or query visibility. That differs from the 167-169 s *detection* time of
2026-10-15, which included a manual crawler run and 30-second polling. On this
day, today's Security Lake partition was already queryable without starting
the crawler.

## What this shows

- **Receipts held under load.** EventBridge accepted every event within its
  1-second publish timeout, with a 138 ms worst case. Fail-open was never
  exercised, so this run produced no unaudited login.
- **Both transports were complete and exactly-once at this volume.** The
  durability difference documented on 2026-10-15 (acknowledged handoff versus
  a task-local buffer) is a failure-mode difference. Healthy load does not
  reveal it.
- **The legacy path lands sooner (about 23 s at p50).** The selected path pays
  for its stronger boundary with roughly 20-25 s of extra delivery delay.
  That is acceptable for investigation but relevant for any near-real-time
  detection built on the lake.
- **25 logins per second is far below the limits of this design.** The task
  used about 11% of its CPU. EventBridge, Firehose and the alarms showed no
  pressure. No bottleneck was reached.

## What this run did not prove

- Behaviour beyond 25 logins per second, or the capacity limit of the task,
  the web proxy, the FireLens router or the service quotas.
- Any failure path. There was no task kill, no publisher timeout, no
  EventBridge denial or throttling, no Firehose failure, DLQ redrive or replay.
  Zero DLQ depth and quiet alarms show only that no failure was observed.
- Accepted-login traffic, which differs only in the event's outcome fields.
- Percentile publish latency per load step. The service's histogram is
  exported as a cumulative statistic set.
- Where the client-side stalls came from.

## Follow-up

1. Add a load mode to `automation/audit-transport-comparison`. It would reuse
   the run contract and evidence schema and add an open-loop rate profile,
   correlation-prefix reconciliation and S3 write-time delays. That makes this
   test repeatable from a checked-in, tested entry point instead of a private
   script.
2. Run the load generator from inside AWS, in the same Region. That removes
   the client-network stalls from the latency measurement, and then raises the
   rate until the first component saturates.
3. Run the failure exercise from the 2026-10-15 follow-up list under load:
   task termination while FireLens holds records, denied publication, target
   failure with DLQ redrive, and archive replay.
4. Export publish duration as delta histograms, or query AMP, so per-step
   publish percentiles are available.
