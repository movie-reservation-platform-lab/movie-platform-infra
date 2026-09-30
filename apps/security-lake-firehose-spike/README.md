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
The source must be created through a separately reviewed, guarded operator step.
Its returned S3 location and provider-role ARN become a private local config
file for this app. That live lifecycle is not automated by this workspace. Do
not commit real account IDs, role ARNs, source locations, or failed records.

## Offline commands

```bash
npm run build --workspace @movie-platform/security-lake-firehose-spike
npm test --workspace @movie-platform/security-lake-firehose-spike
npm run synth --workspace @movie-platform/security-lake-firehose-spike
```

See `docs/operations/security-lake-firehose-feasibility.md` for the operator
workflow and `docs/plans/security-lake-firehose-feasibility.md` for design and
acceptance criteria.
