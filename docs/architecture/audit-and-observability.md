# Audit logging and observability

The demo adds an investigation path: submit incorrect credentials, take the
audit event ID from the response, find the event in Athena, and follow its IDs
into the application log, X-Ray trace and ALB access log. Correct demo credentials
produce a success event. These endpoints validate a synthetic credential pair;
they do not create a session or replace the application's existing auth.

## What runs where

```text
Browser → restricted ALB → Nginx → one of three demo login endpoints
                                      │
                         stdout {"audit": OCSF event}
                                      │
                             ECS FireLens router
                             (AWS for Fluent Bit)
                              /                 \
                  ordinary logs                 validated audit events
                       │                             │
                 CloudWatch Logs               Data Firehose
                                                     │
                                               S3 JSONL/GZIP
                                                     │
                                                Glue + Athena

Application OTel → task-local ADOT → X-Ray, AMP and CloudWatch metrics
ALB access logs ──────────────────→ separate audit-owned S3 bucket
AWS write-management events ─────→ CloudTrail → audit archive prefix
```

| Stack | Owns | Does not own |
| --- | --- | --- |
| `AuditStack` | Firehose, archive/ALB/query-result buckets, CloudTrail trail, Glue tables, Athena workgroup and reader policy, delivery alarm | ECS, VPC, application credentials |
| `ObservabilityStack` | AMP, optional Grafana and read role, app/router/ADOT/metrics/Container Insights log groups, rejection alarm | Workload, audit archive |
| `MovieReservationWorkloadStack` | VPC, endpoints, ALB, ECS, router/ADOT image assets and containers | Audit and observability resources |

Each stack has its own CDK app. Foundation exports use the
`MoviePlatformAwsDemo:` prefix; workload imports them. Neither foundation imports
the workload. Destroy workload first because CloudFormation does not allow an
export to be removed while another stack imports it. Resource replacement in a
foundation can also require removing dependent workloads first. This is a fresh
deployment, not a resource migration.

The existing ECR artifact foundation and GitHub OIDC trust remain separate.
All six apps still share one Fargate task; changing one digest rolls the task,
not just that container. Adding the router keeps the task at 2 vCPU / 4 GiB:
Nginx's CPU reservation drops from 256 to 128 units to make room for the router.
The router has 128 CPU units and 256 MiB. The six apps plus router are essential;
ADOT remains nonessential. A router crash therefore triggers task replacement.

## Event routing

Services own small isolated OCSF builders and stdout adapters. The
[contract](../contracts/platform-audit-v1.json) and
[JSON Schema](../contracts/platform-audit-event-v1.schema.json) describe our
constrained OCSF 1.3 Authentication event—not the full OCSF schema. Activity 99
means the credential validation check, not a newly created login session.

The router parses the Docker `log` field, checks the supported event shape and
producer/container match, then returns the inner event as the record. A private
routing marker sends it only to Firehose and is removed before output. No ECS
wrapper, password, submitted username or raw request body belongs in the archive.
Failed identity is the literal `unknown`, not an unverified caller claim.

Use ASCII release/environment identifiers (Git revisions and `aws-demo` already
are). Producer schemas express 128-character limits; the router additionally
enforces a 128-byte UTF-8 limit on those strings. An oversized multibyte value is
rejected and counted, not truncated into a different identity.

Ordinary log lines retain their original text and go to their component's
CloudWatch group. Invalid audit-shaped records become a static
`audit_router.rejected` diagnostic in the router group; original bytes are not
retained because they may contain credentials. The rejection alarm has no SNS
notification configured: inspect it in CloudWatch or add an approved action.

The router image owns its complete Fluent Bit config, including the FireLens
Unix socket input, rather than appending to ECS's generated config. This lets
`storage.type filesystem` apply to the actual input. ECS still manages the socket
and log-driver connection. We do not add a network listener on port 24224.
[AWS describes this input-override approach](https://aws.amazon.com/blogs/containers/how-to-set-fluentd-and-fluent-bit-input-parameters-in-firelens/).

## Delivery guarantees—and the gaps

- Writing stdout acknowledges only a local write. It does not acknowledge
  Firehose acceptance or S3 persistence.
- The Docker log driver buffers at most 1,024 events per application. Fluent Bit
  uses task-local filesystem buffering: 512 MiB for audit, 64 MiB per operational
  destination, and 16 MiB for rejection diagnostics. These are output backlog
  limits, not an audit-retention guarantee. Exceeding a limit can drop old chunks.
- The router retries delivery without a retry-count ceiling while it is alive.
  On a normal stop, applications stop before the router; Fluent Bit gets a
  110-second grace period inside ECS's 120-second timeout. A crash, forced stop,
  exhausted buffer or Fargate replacement can lose undelivered records.
- Fluent Bit's Firehose output serializes each event with a trailing newline.
  Firehose batches at 1 MiB or about 60 seconds, compresses
  with GZIP and writes under `audit/YYYY-MM-DD/`. Buffer values are hints, not a
  latency SLA. Direct PUT records have a finite delivery-retry window; prolonged
  destination failure can lose data. [Firehose delivery behavior](https://docs.aws.amazon.com/firehose/latest/dev/retry.html)
- Retries can duplicate events. Deduplicate by `metadata.uid`, not trace ID:
  several distinct audit events can legitimately share a trace.

This is useful security audit logging, not a claim of compliance-grade,
lossless or administrator-proof evidence. For business changes whose success
must imply durable audit acceptance, add an outbox or another explicitly
acknowledged durable path. The current stdout interface can remain for other
security events.

## Correlation that can actually be demonstrated

| Identifier | What it connects |
| --- | --- |
| `metadata.uid` | HTTP response, operational audit reference, archived event; stable across retries |
| `metadata.correlation_uid` / `unmapped.platform.request_id` | A demo action/request across application records |
| `unmapped.platform.trace_id` / `span_id` | Actual active OTel context; X-Ray and application logs |
| `unmapped.platform.aws_alb_trace_id` | Sanitized `X-Amzn-Trace-Id` header; compare its `Root` with ALB access-log `trace_id` |
| CloudTrail event/request ID, role and resource ARN | AWS deployment/configuration activity; a separate investigation track |

The ALB root is not assumed equal to the application's OTel trace ID. The
application stores both to bridge those systems. ALB access logs are eventual
and best-effort; requests rejected before an application can run have no app
event. An audit event can outlive its short-retention or unsampled trace.
[ALB access-log behavior](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-access-logs.html)

CloudTrail captures regional write-management events here, not per-login
Firehose receipts. Fluent Bit batches many events into API calls and does not
return a publication request ID to the emitter. There is no supported
one-event/one-CloudTrail-request join in this implementation. CloudFront/WAF are
not deployed; a CloudFront request ID is included only if a real header arrives.
[Firehose CloudTrail operations](https://docs.aws.amazon.com/firehose/latest/dev/monitoring-using-cloudtrail.html)

## Security and retention

The task role can append only to the audit stream, write operational telemetry,
and publish traces/metrics. It cannot read or delete archived evidence. The
Firehose service role writes its S3 prefixes; the CloudTrail and ALB service
principals have their own bucket policies. Task containers share a role, so a
compromised container can still forge/spam stream records. A separate audit
account and independently scoped service tasks are later isolation improvements.

All buckets block public access, require TLS, use SSE-S3 and enable versioning.
Archive and ALB objects expire after 30 days by default; query results after
7 days. Noncurrent versions expire on the same configured interval, so a current
object that expires after 30 days can remain as a billed noncurrent version for
about another 30 days. Deletion is not immediate. Buckets retain on stack deletion unless the operator explicitly
enables disposable-data cleanup. This is not S3 Object Lock.

See the [deployment and cleanup runbook](../operations/audit-demo.md) for the
exact commands, prerequisites, investigation queries and full cost cleanup.
