# Audit Account Application

This workspace is the deployable CDK application for infrastructure owned by the
dedicated **audit account**. It is the composition root: it loads account
configuration and assembles reusable packages into deployable stacks.

The accounts have separate responsibilities:

- the **management account** owns AWS Organizations and delegates Security Lake
  administration;
- the **audit account** owns Security Lake, the central EventBridge bus,
  Firehose, Glue metadata, delivery DLQs, and retained audit data; and
- the **workload accounts** run services such as the reservation service and
  publish audit events to the central bus in the audit account.

```text
workload account                         audit account
reservation service  -- audit event --> EventBridge -> Firehose -> Security Lake
```

The application has two deliberately separate deployment stages:

1. `AuditAccountStack` enables the regional Security Lake foundation, native
   CloudTrail management-event collection for the audit and configured workload
   accounts, and the custom-source crawler identity.
2. `AuditAccountIngestionStack` consumes the private response from
   `CreateCustomLogSource`, then uses `@movie-platform/audit-ingestion` to create
   the central EventBridge-to-Firehose delivery path in the audit account.

The split keeps the Security Lake API handoff visible. AWS CloudFormation can
create the data lake and native source, but it does not currently provide a
custom-log-source resource. The deployment sequence is therefore:

1. deploy `AuditAccountStack` in the audit account;
2. create the `MOVIE_AUTH` custom source through the guarded Security Lake API
   operation and save its private AWS creation receipt locally;
3. deploy `AuditAccountIngestionStack` in the audit account; and
4. in a later slice, authorize and configure workload services to publish to the
   exported central event-bus ARN.

The reusable ingestion package contains the delivery mechanics proven by the
Firehose feasibility experiment: EventBridge routing and archive, target DLQs,
Firehose, Glue conversion metadata, Parquet conversion, Security Lake
partitioning, and malformed-record quarantine. This application supplies the
real account topology and Security Lake destination.

Run credential-free checks from the repository root:

```bash
npm run build --workspace @movie-platform/audit-account
npm test --workspace @movie-platform/audit-account
npm run synth:audit-account
```

Offline synth uses synthetic fixtures under `test/fixtures` and `--no-lookups`.
It synthesizes both stages without contacting or mutating AWS. The stage-specific
commands are `synth:foundation` and `synth:ingestion` in this workspace.

Live ingestion composition requires the unmodified JSON creation receipt returned
by `CreateCustomLogSource`, selected through the absolute path in
`MOVIE_PLATFORM_SECURITY_LAKE_CUSTOM_SOURCE_RESPONSE_FILE`. Runtime validation
requires the expected `MOVIE_AUTH` source/version, assigned S3 prefix, and a
provider role owned by the configured audit account. The receipt describes AWS
resources; it contains no audit events. Never commit the real receipt.

Live operator commands are owned by
[`automation/audit-account-operator`](../../automation/audit-account-operator/README.md)
and require two private files:

- the generic SSO target described by `packages/aws-account-preflight`; and
- an audit topology file selected with the absolute
  `MOVIE_PLATFORM_AUDIT_ACCOUNT_CONFIG_FILE` path.

Follow the [audit-account bootstrap runbook](../../docs/operations/audit-account-bootstrap.md)
before using them. Bootstrap, stack deployment, and custom-source creation are
live AWS mutations and are never part of CI.
