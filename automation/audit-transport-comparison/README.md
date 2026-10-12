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
audit-account DLQ and delivery alarms, and creates versioned JSON evidence
(`audit-transport-comparison/v1`).

## Where things live

Dependencies point inward: `cli/` wires `adapters/` into `core/`, and `core/`
imports neither.

| Folder | Contents | Knows about |
| --- | --- | --- |
| `src/core/` | The use case (`run-comparison.ts`), pure verdict rules (`verdict.ts`), the evidence contract (`comparison-result.ts`), the ports it needs (`ports.ts`), and error redaction | Nothing outside itself |
| `src/adapters/` | One implementation per port: Athena store reader and its SQL, Glue crawler, DLQ/alarm health, HTTP login; plus private files and the terminal summary | `core/`, AWS SDK, Node APIs |
| `src/cli/` | Run-file parsing (`run-config.ts`), argument handling and exit codes (`cli.ts`), the composition root that picks every adapter (`production-dependencies.ts`), and `main.ts` | Everything |

Tests mirror this layout. `test/support/fakes.ts` provides a deterministic
clock and fake stores, so the polling logic runs without AWS or waiting.

## Inputs

This repository is public, so every identifier is an input. The private
environments repository writes the run file and keeps the evidence. The run file
and credentials file must be regular, owner-only files (`chmod 600`); the
evidence path must not exist yet and must be outside this repository.

```json
{
  "schema": "audit-transport-comparison-run/v1",
  "endpoint": "http://<DemoBaseUrl host>",
  "allowInsecureHttp": true,
  "credentialsFile": "/abs/private/auth.json",
  "workloadTargetFile": "/abs/private/workload-aws-target.json",
  "auditTargetFile": "/abs/private/audit-aws-target.json",
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
  "output": "/abs/private/evidence/comparison.json"
}
```

Optional fields and their defaults (`RUN_CONFIG_DEFAULTS` in `cli/run-config.ts`):

| Field | Default | Meaning |
| --- | --- | --- |
| `loginPath` | `/audit-demo/reservation/login` | Login route on the endpoint's origin |
| `allowInsecureHttp` | `false` | The demo ALB is HTTP-only behind the prefix list; use throwaway credentials only |
| `attempts` | `{ "accepted": 3, "rejected": 3 }` | Logins per outcome, 0-20 each |
| `timeoutSeconds` | `1200` | Hard deadline for the whole run |
| `pollIntervalSeconds` | `30` | Time between store lookups |
| `securityLakeStore.refreshCatalog` | `false` | Start the crawler once, so new partitions become queryable |
| `catalogRefreshDelaySeconds` | `90` | Wait after the last login before that crawler start |

- `credentialsFile` uses the same `{"username", "password"}` shape as the demo
  secret. Rejected attempts use a fixed, obviously wrong password.
- The target files are `aws-account-preflight` targets. Each is validated
  against its live SSO caller, and the SDK credentials are checked to reach the
  same account. Ambient credentials and `AWS_ENDPOINT_URL*` overrides are refused.
- `crawlerName`: the Glue crawler created by `CreateCustomLogSource`. The runner
  reads the queryable table from its catalog target; it differs from the
  `tableArn` in the custom-source response.
- The DLQ URL must belong to the audit target account and Region.

## Run

```bash
npm run compare:audit-transports -- --run-file /abs/private/run.json
```

| Exit code | Meaning |
| --- | --- |
| 0 | Every login answered as expected with a receipt, every event reached both stores, delivery health is clean |
| 1 | The comparison ran and found a problem (see the summary and evidence) |
| 2 | Invalid input or failed preflight; no login was sent |
| 3 | Unexpected error, including evidence that could not be written |

The only AWS mutation is one optional crawler start (`refreshCatalog`).

## Reading the result

- Delays are detection times: login to the first poll that saw the event, so
  they are bounded by the poll interval.
- A store is `incomplete` when the deadline passed first, and `error` when a
  query failed (polling that store stops).
- Compare request-path latency per transport from `audit_publish_duration_ms`
  in Grafana. The result's `notes` list what is and is not comparable.
- Error text is redacted (ARNs, accounts, emails, URLs, paths) before it reaches
  the terminal or the evidence, because terminal output gets pasted into public
  issues.

If the Security Lake store reports `Insufficient Lake Formation permission(s)`,
the operator role is not a data lake administrator: grant it `SELECT` and
`DESCRIBE` on the custom-source table as an explicit, approved step.

## Checks

```bash
npm run validate:audit-transport-comparison
```
