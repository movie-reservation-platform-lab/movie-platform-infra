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
Review both generated templates. Confirm that the prerequisite template
contains a Glue-trusted IAM role, the `AWSGlueServiceRole` managed policy, and
S3 access scoped to `ext/MOVIE_AUTH/`. Confirm that
`SecurityLakeAuditIngestionStack.template.json` contains:

- an encrypted Direct Put Firehose stream;
- Glue metadata for JSON-to-Parquet conversion;
- SNAPPY-compressed Parquet output;
- dynamic partition extraction of UTC `eventDay` from epoch-millisecond
  `time`;
- the exact `region/accountId/eventDay` valid-data hierarchy; and
- a separate conversion-error prefix.

## Private prerequisite handoff

Run the normal audit-account preflight. Then read the existing data-lake bucket
ARN without changing AWS:

```bash
aws securitylake list-data-lakes \
  --regions eu-central-1 \
  --profile <audit-profile> \
  --region eu-central-1 \
  --query 'dataLakes[0].{bucketArn:s3BucketArn,region:region}' \
  --output json \
  --no-cli-pager
```

Save that exact object in a private file outside Git and set these environment
variables to absolute paths:

```bash
export MOVIE_PLATFORM_AUDIT_ACCOUNT_CONFIG_FILE=<private-audit-config-path>
export MOVIE_PLATFORM_SECURITY_LAKE_PREREQUISITES_CONFIG_FILE=<private-prerequisite-config-path>
```

Review and deploy only the disposable prerequisite stack:

```bash
npm run cdk:prerequisites --workspace @movie-platform/security-lake-firehose-spike -- \
  diff SecurityLakeCustomSourcePrerequisitesStack --profile <audit-profile>

npm run cdk:prerequisites --workspace @movie-platform/security-lake-firehose-spike -- \
  deploy SecurityLakeCustomSourcePrerequisitesStack --profile <audit-profile>
```

Record the `CrawlerRoleArn` stack output privately. This role is assumed by
Glue; it is not the role Firehose will use.

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

Create a private request file outside Git after replacing both placeholders:

```json
{
  "sourceName": "MOVIE_AUTH",
  "sourceVersion": "1.0",
  "eventClasses": ["AUTHENTICATION"],
  "configuration": {
    "crawlerConfiguration": {
      "roleArn": "<CrawlerRoleArn stack output>"
    },
    "providerIdentity": {
      "principal": "firehose.amazonaws.com",
      "externalId": "<audit account ID>"
    }
  }
}
```

After reviewing the file, the human operator creates the source explicitly:

```bash
aws securitylake create-custom-log-source \
  --cli-input-json file://<private-create-request-path> \
  --profile <audit-profile> \
  --region eu-central-1 \
  --output json \
  --no-cli-pager
```

Save the complete response privately. Create the smaller application config
shown above from `source.provider.roleArn` and `source.provider.location`.

Before CDK deployment, derive the returned provider role name from its ARN and
inspect its trust policy:

```bash
aws iam get-role \
  --role-name <returned-provider-role-name> \
  --profile <audit-profile> \
  --query 'Role.AssumeRolePolicyDocument' \
  --output json \
  --no-cli-pager
```

Stop unless the trusted service is `firehose.amazonaws.com` and the
`sts:ExternalId` condition is the audit account ID. Also inspect the role's
attached and inline policies and confirm that Security Lake granted writes only
to its assigned source location. These read-only checks prove that the role at
the other side of the private ARN has the behavior assumed by the template.

There is not yet a repository command that creates or deletes this source. The
request remains a reviewed, human-executed checkpoint for issue #71.

## Live acceptance checks

After explicit authorization and the normal audit-account preflight:

1. Review `cdk diff` for `SecurityLakeAuditIngestionStack` against the named
   audit account and Region.
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

Destroy the Firehose stack before deleting the custom source:

```bash
aws securitylake delete-custom-log-source \
  --source-name MOVIE_AUTH \
  --source-version 1.0 \
  --profile <audit-profile> \
  --region eu-central-1 \
  --no-cli-pager
```

Security Lake does not delete its custom-source crawler. Delete the exact
crawler returned by the create response only after the source is gone. Finally,
destroy `SecurityLakeCustomSourcePrerequisitesStack`.

Verify that the stream, conversion Glue database/table, delivery logs,
attached provider-role policy, custom source, Security Lake-created crawler,
prerequisite role, and experiment-only objects are gone. Record only redacted
resource types and counts.

An unexplained retained resource, a malformed record in the valid hierarchy,
or a count mismatch fails the checkpoint. Update the ingestion architecture
decision before starting the reusable implementation.

Use
[`docs/plans/evidence/security-lake-firehose-feasibility.md`](../plans/evidence/security-lake-firehose-feasibility.md)
for the redacted result.
