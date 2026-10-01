# Security Lake Firehose spike

This temporary CDK application supports issue #71. It tests whether Amazon Data
Firehose can convert the released OCSF Authentication contract to Parquet and
deliver it into an Amazon Security Lake custom-source partition.

It is intentionally separate from `apps/audit-account`: the stable audit stack
must remain empty until this feasibility checkpoint passes. The spike is also
separate from the reusable ingestion package planned for the next PR.

## Safety boundary

The package-local `build`, `test`, and `synth` commands are credential-free.
Never deploy this application without explicit live authorization, a reviewed
change set, a confirmed target account and Region, and an agreed teardown owner.

Security Lake custom sources are API-managed rather than CloudFormation-managed.
The prerequisite stack creates only the Glue crawler role required by that API.
The source must then be created through the separately reviewed operator step,
with Firehose as its provider identity. Its returned S3 location and provider
role ARN become a private local config file for the ingestion stack. The API
lifecycle is not automated by this workspace. Do not commit real account IDs,
role ARNs, source locations, or failed records.

## Offline commands

```bash
npm run build --workspace @movie-platform/security-lake-firehose-spike
npm test --workspace @movie-platform/security-lake-firehose-spike
npm run synth --workspace @movie-platform/security-lake-firehose-spike
```

The combined synth emits two independent templates:

1. `SecurityLakeCustomSourcePrerequisitesStack` creates the disposable Glue
   crawler role before the custom source exists.
2. `SecurityLakeAuditIngestionStack` creates Firehose only after the custom
   source has returned its assigned location and provider role.

See `docs/operations/security-lake-firehose-feasibility.md` for the operator
workflow and `docs/plans/security-lake-firehose-feasibility.md` for design and
acceptance criteria.
