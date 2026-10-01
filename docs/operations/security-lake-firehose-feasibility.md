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
- a metadata-only Glue table and a separate Firehose-assumable schema role for
  JSON-to-Parquet conversion;
- Lake Formation `DESCRIBE` grants on that conversion database and table,
  created before Firehose validates the schema;
- the Security Lake provider role used only for S3 delivery, with one additional
  `s3:PutObject` grant scoped to the sibling conversion-error prefix and no Glue
  or CloudWatch permissions;
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
  "sourceLocation": "s3://<returned bucket>/ext/<returned source>/<returned version>/"
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
The generated role's `AmazonSecurityLakePermissionsBoundary` permits only the
Security Lake S3/KMS/SQS action set, so the ingestion stack must not attach
Glue or CloudWatch permissions to it. A separate Firehose-assumable role reads
the stack-owned conversion schema. Delivery logging remains disabled for this
checkpoint because the S3 destination configuration has no separate logging
role. Security Lake's generated inline policy grants only its assigned valid
source prefix. The ingestion stack therefore attaches one additional policy
that grants `s3:PutObject` only to the configured sibling error prefix.

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
7. Confirm the malformed record never appears in the valid dataset and that it
   reaches the sibling error prefix. Failure of error delivery means the scoped
   provider-role grant needs correction or the design needs a separately
   authorized quarantine destination.
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

Deleting a data lake can retain its S3 bucket, Lake Formation registration,
service-linked roles, event-processing Lambda, EventBridge resources, and SQS
queues. When the data lake was created solely for this checkpoint, inventory
and remove each retained experiment resource explicitly. Do not edit protected
AWS service-linked roles directly. AWS may retain one with stale policy text
after its data location and bucket are gone; record that explained, non-billable
AWS-owned artifact instead of trying to bypass the service protection.

Verify that the stream, conversion Glue database/table, conversion-schema role,
custom source, Security Lake-created crawler, prerequisite role, and
experiment-only objects are gone. Record only redacted resource types and
counts.

An unexplained retained resource, a malformed record in the valid hierarchy,
or a count mismatch fails the checkpoint. Update the ingestion architecture
decision before starting the reusable implementation.

## Follow-up automated validation

Keep pull-request checks credential-free. Once the reusable ingestion path and
dedicated test tenant exist, add an opt-in post-deploy canary that publishes a
uniquely identified synthetic event, polls Athena with a bounded timeout, and
validates its exact fields and partition. A tenant smoke test should also
perform a real audited action and reconcile its correlation or event ID in
Security Lake. The synthetic canary diagnoses the ingestion path independently;
the tenant test proves the application integration. Run the canary periodically
as well as after deployment so a quiet tenant cannot hide a delivery failure.

Use
[`docs/plans/evidence/security-lake-firehose-feasibility.md`](../plans/evidence/security-lake-firehose-feasibility.md)
for the redacted result.
