# Audit demo implementation plan — September 8, 2026

Tracking: [infra #43](https://github.com/movie-reservation-platform-lab/movie-platform-infra/issues/43).

## Goal and scope

Build a fresh three-stack demo: independent observability, independent audit
storage, and the existing six-container ECS workload. Nothing remains deployed
from the previous demo, so no CloudFormation ownership migration is needed.
This delivery is code, tests, documentation, commits and PRs only; agents must
not deploy or destroy AWS resources.

Three services produce OCSF Authentication events from an explicitly enabled
demo credential-check endpoint. This does not replace existing authentication
or grant application sessions. The shared wire contract is
`docs/contracts/platform-audit-v1.json`.

## Chosen architecture

Applications write one JSON line `{ "audit": <OCSF event> }`. A task-local
FireLens/AWS for Fluent Bit router parses it, strips the envelope, and sends
the event to Data Firehose. Firehose batches newline-delimited JSON into S3;
Athena queries an explicit Glue table. Ordinary application output goes to
CloudWatch, not the audit archive. Invalid audit envelopes produce a bounded,
redacted router diagnostic, not a copy of the authentication payload.

This is the user-selected log-shipping design. SQS/Lambda and direct application
Firehose publishing were considered and rejected: neither is the requested
transport. Security Lake, OpenSearch, Parquet, multi-account isolation, production
identity and generalized image admission are follow-ups, not prerequisites.

`ObservabilityStack` owns AMP, Grafana access, application/collector/router log
groups and Container Insights logs. `AuditStack` owns Firehose, archive/query/ALB
log storage, Glue and Athena. `MovieReservationWorkloadStack` owns the VPC,
endpoints, ECS task and ALB. Output imports run only from workload toward
the two foundations. Each foundation has its own CDK entrypoint and can be
synthesized or deployed without application image inputs.

## Security and reliability boundaries

- Same account, distinct roles; workload can append to one Firehose stream and
  cannot read or delete the archive. Task roles are shared by containers, so this
  does not isolate a compromised application from its router's write permission.
- Credentials enter ECS through an existing Secrets Manager secret reference;
  never CDK context plaintext, source-controlled defaults, logs or outputs.
- No NAT. Explicit Firehose and optional Secrets Manager endpoints cover private
  task traffic. Only the existing restricted ALB ingress reaches applications.
- Filesystem buffering is task-local, bounded, and lost when a Fargate task dies.
  Successful stdout write is not Firehose acknowledgement or durable acceptance.
  Retries can duplicate events; use `metadata.uid` to deduplicate investigations.
- S3 buckets retain by default. Documented opt-in disposable mode permits
  full cleanup after the operator confirms data is no longer needed.
- Native ALB `X-Amzn-Trace-Id` joins the event to ALB access logs. Actual OTel
  trace/span IDs join application logs and X-Ray. CloudTrail control-plane records
  are a separate deployment investigation track; batching does not provide a
  one-to-one application-event to Firehose request ID mapping.

## Implementation order

1. Freeze the producer fixture, nested correlation paths and auth environment
   names with all service repositories. Verify real service output against it.
2. Extract observability ownership to `lib/observability-stack.ts`; add minimal
   foundation config and a separate entrypoint. Preserve existing output names
   in workload for smoke-tool compatibility using imports.
3. Add `lib/audit-stack.ts`: private encrypted versioned buckets, stream role,
   Direct PUT Firehose, explicit JSON table, bounded Athena workgroup and useful
   SQL. Add ALB log permission before workload deployment.
4. Add `audit-router/` pinned image, routing config and validation tests. Wire
   FireLens, resources, task role, private endpoints, secrets, graceful shutdown
   and ALB logging into the workload. Keep the task at its current paid size.
5. Add offline stack assertions and a real container routing test. Test regular,
   valid audit, invalid audit, escaped values and all three producers.
6. Write architecture and deployment/destruction runbooks with exact commands,
   account checks, image-digest inputs, foundation order, output lookup, query
   latency expectations, retained-resource cleanup and rollback.

## Verification and rollout

Run TypeScript build, focused Jest assertions, router container tests and the
repository CI equivalent including offline synth. No live AWS commands. In the
later operator-run deployment: deploy audit and observability first, then
workload; submit good and bad demo credentials; inspect response identifiers,
Athena, application logs, X-Ray and ALB evidence. Athena and ALB arrival are
asynchronous, not a subsecond UI promise.

Rollback means redeploying the previous six exact image digests. Teardown means
draining workload before deleting its network, then stopping/deleting delivery
and telemetry services. Retained buckets and CDK assets need separate explicit
cleanup; deleting an ECS service alone is not cost cleanup.

## Risks and done criteria

Main risks are router configuration correctness, sensitive-data leakage, startup
resource limits, incompatible service fixtures and assuming undeployed code is
AWS-proven. Mitigate with real Fluent Bit tests, rejection redaction, CPU/memory
assertions, shared fixture tests and honest offline-only verification notes.

Done: foundation/workload templates have one-way ownership; valid OCSF is
the only audit stream payload; regular logs remain readable; demo secrets stay
out of templates; native correlation paths are documented and queryable; build,
tests and offline synth pass; reviewers receive a PR with a title beginning
`[ai]`. Every implementation commit must also begin `[ai]`.
