# Audit-account application composition

Status: implementation plan for issue #81 and PR 6 of the audit demo.

## Goal

Compose the reusable audit-ingestion package into the dedicated audit account,
enable a bounded native CloudTrail source, and expose the central event-bus
contract needed by the workload connection slice.

## Lifecycle boundary

The application uses two stacks because the custom source is an explicit AWS API
handoff:

```text
AuditAccountStack
  -> Security Lake data lake, native CloudTrail source, crawler role
  -> operator reviews and calls CreateCustomLogSource
  -> private AWS response file
  -> AuditAccountIngestionStack
  -> EventBridge bus/archive/rule/DLQ/Firehose
```

`AWS::SecurityLake::DataLake` and `AWS::SecurityLake::AwsLogSource` are native
CloudFormation resources. `CreateCustomLogSource` creates the provider role,
assigned S3 prefix, Glue query table, and crawler, but has no corresponding
CloudFormation resource. This PR does not hide that release action in a custom
resource Lambda.

## Decisions

- Use S3-managed encryption for the first demo data lake. Customer-managed KMS
  adds key-policy and service-linked-role ownership that is not needed to prove
  this path; revisit it before a production promotion.
- Expire Security Lake objects after 30 days to bound demo storage.
- Enable only CloudTrail management events, version 2.0, for the configured audit
  and workload accounts.
- Give each workload account an EventBridge resource-policy entry. PR 7 adds the
  matching exact task-role identity policy and private EventBridge endpoint.
- Keep alarms and Grafana composition in issue #78 and live verification in #75.
- Do not invent a Security Lake query subscriber until an investigator identity
  and access mode have been reviewed.

## Configuration

The existing audit topology file remains usable before Security Lake exists. The
second stage additionally reads the private, unmodified custom-source response
selected by `MOVIE_PLATFORM_SECURITY_LAKE_CUSTOM_SOURCE_RESPONSE_FILE`.

The parser accepts only source `MOVIE_AUTH`, version `1.0`, the assigned
`ext/MOVIE_AUTH/1.0/` location, and a provider role in the configured audit
account. Repository fixtures use synthetic account IDs and ARNs.

## Verification

- Build and test `@movie-platform/audit-account` and `@movie-platform/audit-ingestion`.
- Synthesize both app stages offline with `--no-lookups`.
- Assert the data-lake retention/encryption contract, CloudTrail account
  allowlist, workload bus policy, reusable ingestion composition, and exported
  bus contract.
- Run workspace-boundary validation, `git diff --check`, and repository CI.
- Review a CloudFormation change set separately before any live deployment.

## Hybrid ownership

The engineer owns two focused assertions:

1. the native CloudTrail source includes exactly the configured audit/workload
   accounts; and
2. the ingestion stack exports the central event-bus contract used by PR 7.

AI owns configuration/loading, surrounding stack composition, documentation,
mechanical fixes, and verification. Review behavior before style and discuss one
semantic issue at a time.
