# Audit transport comparison

Compares the two reservation-service audit transports during the live
checkpoint ([plan](../../docs/plans/audit-transport-comparison.md)):

```text
login -> audit_event_id
  primary: EventBridge -> Firehose -> Security Lake (audit account)  -> Athena
  mirror:  stdout -> FireLens -> legacy Firehose -> S3 (workload account) -> Athena
```

The runner sends a few controlled logins, polls both Athena stores for the
returned event IDs until all are found or the deadline passes, checks the
audit-account DLQ and delivery alarms, and writes versioned JSON evidence
(`audit-transport-comparison/v1`).

## Inputs

This repository is public, so every identifier is an input. The private
environments repository writes the run file and keeps the evidence. The run file,
credentials file, and target files must be owner-only (`chmod 600`).

```json
{
  "schema": "audit-transport-comparison-run/v1",
  "endpoint": "http://<DemoBaseUrl host>",
  "allowInsecureHttp": true,
  "credentialsFile": "/abs/private/auth.json",
  "workloadTargetFile": "/abs/private/workload-aws-target.json",
  "auditTargetFile": "/abs/private/audit-aws-target.json",
  "attempts": { "accepted": 3, "rejected": 3 },
  "legacyStore": {
    "workGroup": "movie-platform-audit",
    "database": "movie_platform_audit",
    "table": "authentication"
  },
  "securityLakeStore": {
    "workGroup": "movie-platform-audit-investigation",
    "crawlerName": "<Security Lake custom-source crawler>",
    "refreshCatalog": true
  },
  "deliveryHealth": {
    "deadLetterQueueUrl": "https://sqs.eu-central-1.amazonaws.com/<audit account>/<target DLQ>",
    "alarmNamePrefix": "AuditAccountIngestionStack-AuditDeliveryAlarms"
  },
  "timeoutSeconds": 1200,
  "pollIntervalSeconds": 30,
  "catalogRefreshDelaySeconds": 90,
  "output": "/abs/private/evidence/comparison.json"
}
```

- `credentialsFile` uses the same `{"username", "password"}` shape as the demo
  secret. Rejected attempts use a fixed, obviously wrong password.
- The target files are `aws-account-preflight` targets. Each is validated
  against its live SSO caller before any AWS call; ambient credentials are never
  used.
- The demo ALB is HTTP-only behind the operator prefix list, so plain HTTP needs
  `allowInsecureHttp`. Use throwaway credentials only.
- `crawlerName`: the Glue crawler created by `CreateCustomLogSource`. The runner
  reads the queryable table from its catalog target; it differs from the
  `tableArn` in the custom-source response.

## Run

```bash
npm run compare:audit-transports -- --run-file /abs/private/run.json
```

Exit codes: `0` passed, `1` comparison failed (see the summary and evidence),
`2` invalid input or failed preflight.

The only AWS mutation is one optional crawler start (`refreshCatalog`), needed
because new `eventday` partitions are invisible to Athena until the crawler runs.

## Reading the result

Delays are detection times: login to the first poll that saw the event, so they
are bounded by the poll interval. Compare request-path latency per transport
from `audit_publish_duration_ms` in Grafana. The result's `notes` list what is
and is not comparable between the two stores.

If the Security Lake store reports `Insufficient Lake Formation permission(s)`,
the operator role is not a data lake administrator: grant it `SELECT` and
`DESCRIBE` on the custom-source table as an explicit, approved step.

## Checks

```bash
npm run validate:audit-transport-comparison
```
