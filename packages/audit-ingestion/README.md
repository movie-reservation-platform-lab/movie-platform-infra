# Audit ingestion

> **Temporary contract distribution:** Until the audit contract is released as
> a standalone versioned artifact, this package vendors a reviewed copy from the
> producer repository. The copy and its hashes provide review evidence; they do
> not automatically generate the Glue schema. Replace this workflow with a
> package or schema-registry dependency before treating it as a durable platform
> interface.

This package provides the reusable EventBridge-to-Firehose path for the
`platform-audit/1` Authentication contract. It accepts explicit configuration;
it does not import deployable apps or read environment configuration. Account
composition belongs in apps and live operations belong in automation.

`AuditIngestion` creates a dedicated event bus and archive, then one routing
rule, target DLQ and Firehose stream for each configured workload account. Rules
accept the pinned source/detail/envelope contract and forward only the OCSF
record at `$.detail.event`. Firehose converts records with a shared Glue schema
and writes valid and quarantined records to separate prefixes.

The package owns no custom-source lifecycle or bucket. Its caller supplies the
Security Lake destination and provider role returned by account composition.
The source allowlist is deliberately explicit: adding a service requires a
reviewed contract and routing update.

The pinned payload bundle and its hashes live under `contract/`. Updating it is
an explicit operation from a reviewed local checkout; normal builds and synths
never fetch mutable upstream content:

```bash
npm run vendor:audit-contract -- \
  /absolute/path/to/packages/audit-sdk/contract \
  <40-character-reviewed-source-commit>
```

Review transport-source changes separately because the upstream payload manifest
does not yet carry the EventBridge source/detail/envelope contract.

From the repository root:

```bash
npm run build --workspace @movie-platform/audit-ingestion
npm test --workspace @movie-platform/audit-ingestion
```

See [the PR 5 plan](../../docs/plans/audit-ingestion-package.md) for ownership,
the quarantine retest gate and the later delivery-resource work.
