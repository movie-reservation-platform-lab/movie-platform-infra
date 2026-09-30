# Security Lake Firehose Feasibility Runbook

This runbook controls the disposable issue #71 checkpoint. It tests whether
Amazon Data Firehose can convert the released `platform-audit/1` JSON contract
to Parquet and deliver it into an Amazon Security Lake custom source.

The repository currently automates the credential-free build, tests, and
synthesis. Creating the Security Lake custom source, deploying the stack,
sending records, querying them, and cleaning up are live AWS actions. Perform
those actions only after a separate review names the target account, operator
profile, execution window, budget, and teardown owner.

## Offline gate

Run from the repository root:

```bash
npm run build --workspace @movie-platform/security-lake-firehose-spike
npm test --workspace @movie-platform/security-lake-firehose-spike
npm run validate:workspace-boundaries
npm run synth:security-lake-audit-ingestion
git diff --check
```

The synth uses fake values from committed fixtures and performs no AWS lookup.
Review the generated `SecurityLakeAuditIngestionStack.template.json`. Confirm
that it contains:

- an encrypted Direct Put Firehose stream;
- Glue metadata for JSON-to-Parquet conversion;
- SNAPPY-compressed Parquet output;
- dynamic partition extraction of UTC `eventDay` from epoch-millisecond
  `time`;
- the exact `region/accountId/eventDay` valid-data hierarchy; and
- a separate conversion-error prefix.

## Private custom-source handoff

Security Lake custom-source creation is an API operation and is not owned by
this CloudFormation stack. The live operator must first create one temporary
Authentication-class source and capture its returned provider role and S3
location in a private file outside Git:

```json
{
  "providerRoleArn": "<returned Security Lake provider role ARN>",
  "sourceAccountId": "<approved workload account ID>",
  "sourceLocation": "s3://<returned bucket>/ext/<returned source>/"
}
```

Set `MOVIE_PLATFORM_AUDIT_ACCOUNT_CONFIG_FILE` and
`MOVIE_PLATFORM_SECURITY_LAKE_FIREHOSE_SPIKE_CONFIG_FILE` to absolute paths.
The app rejects an unexpected audit account, Region, workload account, role,
or non-`ext/` source location before synthesis.

There is not yet a repository command that creates or deletes this source.
Record the reviewed API or CLI procedure before the live gate; do not improvise
it from the sample fixture.

## Live acceptance checks

After explicit authorization and the normal audit-account preflight:

1. Review `cdk diff` against the named audit account and Region.
2. Deploy only `SecurityLakeAuditIngestionStack`.
3. Send canonical synthetic Authentication events with stable event IDs.
4. Send one intentionally malformed synthetic record.
5. Confirm valid output is Parquet under the assigned
   `region/accountId/eventDay` hierarchy.
6. Confirm Athena can query the expected fields and reconcile submitted event
   IDs with queryable event IDs.
7. Confirm the malformed record never appears in the valid dataset. Record
   whether the Security Lake provider role permits the sibling error prefix;
   failure here is evidence that the proposed simple Firehose path is
   insufficient or needs a separately authorized quarantine destination.
8. Record event-to-query delay and the submitted, accepted, failed, and
   queryable counts in the evidence template.

Use only synthetic data. Do not commit raw events, failed records, account IDs,
role ARNs, bucket names, query result locations, or credentials.

## Teardown gate

Destroy the Firehose stack before deleting the custom source. Then verify that
the stream, conversion Glue database/table, delivery logs, attached provider
role policy, custom source, and any experiment-only crawler or objects are
gone. Record only redacted resource types and counts.

An unexplained retained resource, a malformed record in the valid hierarchy,
or a count mismatch fails the checkpoint. Update the ingestion architecture
decision before starting the reusable implementation.

Use
[`docs/plans/evidence/security-lake-firehose-feasibility.md`](../plans/evidence/security-lake-firehose-feasibility.md)
for the redacted result.
