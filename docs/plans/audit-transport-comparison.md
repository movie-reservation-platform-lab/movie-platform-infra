# Audit transport comparison (PR 9a)

Status: implementation plan. Splits PR 9 of
[eventbridge-security-lake-audit-demo](./eventbridge-security-lake-audit-demo.md):
**9a** (this plan) delivers the comparison runner for the live checkpoint; **9b**
(later) automates demo-stop and full removal. Until 9b, teardown follows the
existing runbooks by hand.

## Goal

Make the live checkpoint repeatable: one command sends controlled logins
through the deployed reservation service and reports, per audit event, whether
and when it reached each audit store.

```text
POST /demo/auth/login --> audit_event_id (OCSF metadata.uid)
   |-- primary:  PutEvents -> central bus (audit account) -> Firehose -> Security Lake -> Athena
   `-- mirror:   stdout -> FireLens -> legacy Firehose (workload account) -> S3 -> Athena
```

## Decisions (consultation, 2026-10-12)

- **Automate the boring parts, keep humans on irreversible steps.** No new deploy
  or teardown orchestrator: deploy approvals and evidence stay in the guided
  demo of the private environments repository.
- **Split by responsibility and visibility.** This public repository owns the
  runner, because it knows the resource contract. The private environments
  repository owns target resolution, credentials, deploy orchestration, and
  evidence storage. The runner therefore receives every account ID, profile,
  ARN, endpoint, and credential as input, commits only synthetic fixtures, and
  writes evidence only to a caller-supplied path.
- **Comparison core only.** Section 6.7 extras (SDK control-path event, OCSF and
  partition validation, native CloudTrail) move to the PR 9 follow-up.
- **Equalize the Firehose buffer.** The central stream's buffer interval drops
  from 300 s to the legacy stream's 60 s, so delivery delay compares transports,
  not buffer settings. Cost: about five times more, smaller Parquet objects.
- **Environments blocker first.** The guided demo must pass the central bus ARN
  to the workload synth (environments #125, slice 1) before any deploy.

## Comparison strategy

The checkpoint compares two **audit architectures**, not two pipes into one
store. Each report must say which results are comparable and which are not.

Comparable:

- **Request-path latency** per publisher (`audit_publish_duration_ms` by
  `audit_publisher`), independent of the destination. Read from Grafana/AMP.
- **Per-event reconciliation**: every returned `audit_event_id` is present in
  both stores, or the report names the store that lacks it.
- **Loss under failure**: an acknowledged `PutEvents` versus a fire-and-forget
  sidecar buffer (forced task stop, publish timeout, delivery failure).

Not comparable, so stated rather than "fixed":

- **Delivery delay.** After buffer equalization, the remaining differences are
  Parquet conversion and Security Lake partition registration (new path)
  versus gzipped JSON (legacy path). Detection time is also bounded by the
  runner's poll interval.
- **Account placement.** The legacy store lives in the workload account, where a
  workload administrator can delete it; the new store lives in the separate audit
  account. This is a finding in favour of the new path, not an unfair setup.
- **Fail-open logins.** A successful login whose primary publish failed returns no
  `audit_event_id`; the runner counts it as unaudited instead of tracking it.

Postponed experiment (a third design, not the original): route FireLens into the
audit account's Security Lake through cross-account Firehose with role
assumption and Parquet conversion. It would separate the transport from the
destination, but is days of work; revisit after the gate decision.

## Runner design

New workspace `automation/audit-transport-comparison`
(`@movie-platform/audit-transport-comparison`), following
`automation/artifact-foundation-cleanup`: a thin CLI, a pure comparison core,
injectable AWS SDK adapters, and Jest tests with fakes.

Inputs (one JSON run file, written by the environments repository):

- `endpoint`: reservation-service base URL;
- `credentialsFile`: demo username/password file, never printed or copied;
- `attempts`: successful and rejected login counts (default 3 + 3);
- `workloadTargetFile`, `auditTargetFile`: `aws-account-preflight` target files,
  validated before any AWS call; ambient credentials are never used;
- `legacyStore`: Athena workgroup, database, table (`movie-platform-audit`,
  `movie_platform_audit`, `authentication`);
- `securityLakeStore`: Athena workgroup and the Security Lake-created crawler
  name; the runner reads the queryable database and table from the crawler's
  catalog target, because they differ from the `tableArn` in the custom-source
  response;
- `deliveryAlarmPrefix`, `deadLetterQueueUrl`: audit-account health inputs;
- `timeout` (default 20 min) and `pollInterval` (default 30 s);
- `output`: absolute evidence path.

Phases, each with its own status in the result:

1. Preflight both account targets.
2. Send the logins with unique `X-Correlation-Id`/`X-Request-Id`; record HTTP
   status, response time, and `audit_event_id` (or its absence).
3. After one buffer interval, optionally (`refreshCatalog`) start the Security
   Lake crawler once, because new `eventday` partitions are invisible to Athena
   until it runs. Then poll both stores with bounded Athena queries (`metadata.uid IN (...)`,
   restricted to the run's UTC partitions) until every ID is found or the
   timeout expires. Record the first poll that saw each ID.
4. Check the audit-account DLQ depth and that no delivery alarm is in `ALARM`.
5. Write versioned JSON (`audit-transport-comparison/v1`) and print a short
   per-event table.

The runner never retries a login, never loops without a deadline, and exits
non-zero when any event is missing from either store.

## Infrastructure changes

- `AuditIngestion` gains an optional `bufferInterval` prop (default 300 s), set
  to 60 s by `AuditAccountIngestionStack`.
- The audit account has no Athena workgroup (the `primary` workgroup has no
  result location). Add a dedicated workgroup with enforced
  **Athena-managed query results** to `AuditAccountIngestionStack`, so no result
  bucket exists. The October 2026 feasibility run created the same thing by hand.

## Known risks for the live run

- **Lake Formation access.** Querying the Security Lake table needs Lake
  Formation permission. In the feasibility run the operator role was a data lake
  administrator; if it is not, the runbook grants `SELECT`/`DESCRIBE` as an
  explicit, approved manual step, because who investigates is still an open
  design point. The runner reports `AccessDenied` clearly.
- **Partition registration.** Starting the crawler is the only mutation the
  runner can perform, and only with `refreshCatalog`. A crawl takes minutes; the
  reported delay includes it.

## Verification

- Unit tests: comparison core (found, missing, late, no receipt, duplicates),
  Athena polling deadline, input validation, and result schema.
- Adapter tests with SDK fakes; no credentials or network in CI.
- `npm run validate:audit-ingestion`, `npm run test:cdk:audit-account`,
  `npm run synth:audit-account`, and the new workspace's build and tests.

## AWS resource impact

Synth-only in this PR. The live run is a separate, explicitly approved release
action driven from the environments repository.
