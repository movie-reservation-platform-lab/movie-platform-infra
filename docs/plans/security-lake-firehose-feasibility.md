# Implementation Plan: Security Lake Firehose Feasibility Checkpoint

## 1. Summary

Create a temporary, independently synthesizable CDK application that proves
whether Amazon Data Firehose can convert the released audit contract from JSON
to Parquet and write it into the exact prefix assigned to an Amazon Security
Lake custom source. Keep custom-source creation and deletion in the guarded
operator because CloudFormation does not expose that resource.

The experiment is a release checkpoint for issue #71. Its infrastructure is
not the reusable ingestion package planned for PR 5.

## 2. Goals

- Consume the audit contract from `movie-reservation-service` at an immutable
  source revision and verify every vendored checksum.
- Synthesize the conversion schema, Firehose stream, logging, encryption, and
  failure-output isolation without AWS lookups.
- Define the guarded handoff required to create and delete the custom source;
  the repository does not yet automate that API lifecycle.
- Record redacted live evidence for conversion, partitioning, queryability,
  failure isolation, timing, and complete cleanup.

## 3. Non-goals

- No production event bus, archive, alarms, subscriber, or workload wiring.
- No reusable `packages/audit-ingestion` API.
- No Lambda transform or application-side Parquet generation.
- No deployment from CI and no live action without explicit authorization.

## 4. Current State

- `apps/audit-account` is an empty stable deployment boundary.
- `automation/audit-account-operator` provides guarded preflight, status, and
  bootstrap commands.
- The service repository contains audit contract `platform-audit/1`, OCSF
  `1.3.0`, and canonical Authentication fixtures at merge commit `6a1fdd3`.
- The released OCSF payload contains event time but does not contain the source
  AWS account or Region.
- Security Lake custom-source creation is available through the AWS API/CLI but
  not as a CloudFormation resource in the installed CDK library.

## 5. Requirements and Assumptions

### Confirmed requirements

- Region is `eu-central-1`.
- The source contains only OCSF Authentication class `3002` events.
- Valid objects use the source location followed by
  `region=<region>/accountId=<account>/eventDay=<YYYYMMDD>/`.
- Conversion errors must use a separate restricted prefix.
- The experiment must delete all resources it creates.

### Assumptions

- The custom source and Firehose stream use the same audit account.
- The operator captures the custom-source location and provider role returned
  by `CreateCustomLogSource` and passes them to the delivery stack.
- The initial live run uses synthetic audit events only.
- This checkpoint targets one configured workload account. Region and account
  are static validated deployment inputs; only UTC `eventDay` is derived from
  each event.

### Open questions resolved at the live gate

- Whether Security Lake is already enabled in the target audit account.
- The exact operator profile and permission set used for the experiment.
- The approved budget, execution window, and teardown owner.

## 6. Proposed Design

Use `apps/security-lake-firehose-spike` as a temporary deployable composition
root. It contains the vendored contract, the Firehose conversion Glue table,
the delivery stream, and focused template assertions.

The live workflow has two phases:

1. CDK creates a disposable Glue crawler role scoped to the expected custom
   source prefix. The operator passes the existing account preflight, then
   follows a separately reviewed API or CLI procedure to create the custom
   source with Firehose as the provider identity. Its response supplies the
   Security Lake source location and provider role.
2. A read-only gate proves that the generated provider role trusts Firehose
   with the audit account as its external ID. Its Security Lake permissions
   boundary limits it to destination access, so CDK creates a separate
   Firehose-assumable role for Glue conversion-schema reads, grants it Lake
   Formation `DESCRIBE` on the conversion database/table, and leaves delivery
   logging disabled. Because Security Lake grants the provider role only the
   valid source prefix, CDK adds a separate `s3:PutObject` grant scoped to the
   sibling conversion-error prefix. CDK then deploys the Firehose delivery stack
   using the returned values. The operator sends canonical and malformed
   records, queries the custom source, records redacted results, then destroys
   the stack and custom source.

The conversion Glue table belongs to Firehose. The Security Lake-created Glue
table and crawler remain separate because they describe the delivered dataset
for query consumers.

This single-account prefix proves the managed conversion path without silently
changing the released event contract. Before PR 5 supports several workload
accounts, its design must choose an explicit account-routing mechanism, such as
one rule/stream per account or a versioned transport envelope that can be
removed without changing the stored OCSF record.

## 7. Alternatives Considered

### CloudFormation custom resource

- Pro: one deployment command could create the custom source.
- Con: introduces a provisioning Lambda and obscures a release action that
  needs explicit operator review.
- Decision: rejected for the checkpoint.

### Add spike resources directly to `AuditAccountStack`

- Pro: fewer workspace files.
- Con: mixes disposable experimental resources into the stable application
  identity and makes accidental deployment easier.
- Decision: rejected.

## 8. Interfaces

The spike reads an explicit JSON configuration containing the audit account ID,
Region, custom-source S3 location, and provider-role ARN. Parsing happens once
at the composition root. The stack receives a typed configuration object.

The existing account preflight remains mandatory before live work. The
prerequisite and ingestion stacks consume separate private configuration files
because the latter cannot exist until the API assigns a source location. A
future repository-owned custom-source mutation command must add an explicit
execution gate and sanitized dry-run output; this checkpoint documents the
reviewed request but does not automate it.

## 9. Security and Privacy

- Use only synthetic events.
- Encrypt Firehose data. Delivery logging is disabled because the generated
  Security Lake destination role cannot receive CloudWatch permissions through
  its permissions boundary.
- Add only `s3:PutObject` for the exact sibling error-object prefix; keep Glue
  schema access on the separate Firehose role.
- Never publish raw failed records in committed evidence.
- Refuse account, Region, role, or source-location mismatches before mutation.

## 10. Reliability and Cleanup

- A failed conversion must not place an object under the valid source prefix.
- Stable event IDs allow submitted and queryable counts to be reconciled.
- Teardown order is Firehose stack, custom source, Security Lake-created
  crawler leftovers, prerequisite stack, and any disposable data lake created
  solely by the experiment.
- Any unexplained retained resource fails the checkpoint.
- A protected AWS service-linked role may remain when its registrations and
  backing resources are gone. Record it as an explained AWS-owned artifact and
  do not attempt to modify it directly.

## 11. Implementation Steps

1. Vendor and verify the contract.
   - Add the contract files, provenance manifest, and checksum validation.
   - Verification: a focused test detects content or provenance drift.
2. Scaffold the disposable CDK application.
   - Add package-local build, test, CDK, and offline synth commands.
   - Add typed input boundaries and the Firehose conversion schema.
3. Implement the partition behavior.
   - Configure inline dynamic partition extraction and the assigned Security
     Lake prefix; isolate Firehose errors.
   - Verification: focused CloudFormation assertions prove the behavior.
4. Define the guarded live handoff.
   - Document the private source-output shape, required account preflight,
     evidence fields, and teardown inventory.
   - Review the exact API or CLI lifecycle procedure before live execution;
     operator automation may follow as a separate change.
5. Review before live execution.
   - Run build, tests, workspace validation, offline synth, and `cdk diff`.
6. Execute and record the authorized experiment.
   - Record redacted timing/count/query results and cleanup inventory.
   - Update the architecture decision before PR 5 begins.

## 12. Testing Strategy

- Contract checksum and provenance tests.
- Runtime configuration rejection tests.
- Fine-grained CDK assertions for Glue schema, Parquet settings, encryption,
  IAM resources, valid prefix, and error prefix.
- Operator tests with injected fake AWS CLI results.
- Offline synth with synthetic account data and `--no-lookups`.
- Live validation only after reviewed authorization.
- After the reusable path and test tenant exist, add a post-deploy synthetic
  canary and a real tenant smoke action. Reconcile unique event IDs in Athena;
  do not make pull-request checks depend on a shared live environment.

## 13. Done Criteria

- The offline spike is independently buildable, testable, and synthesizable.
- The offline application is reviewable without AWS credentials or lookups.
- A separately authorized live run records redacted evidence that proves or
  disproves the Firehose option.
- Cleanup inventory is empty except explicitly declared retained items.
- The live result chooses Option A or triggers the documented Option B update.
- The malformed-record path is accepted only after a focused live retest proves
  the scoped error-prefix grant.
