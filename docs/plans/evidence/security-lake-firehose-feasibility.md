# Security Lake Firehose Feasibility Evidence

Status: valid-path and scoped quarantine retest passed; retest teardown verified.

Do not record account IDs, role ARNs, bucket names, raw events, failed payloads,
credentials, or private query locations in this file.

## Execution boundary

- Date and approved window: 2026-10-01, same-session teardown window extended
  by one hour during investigation.
- Operator role classification: audit-account Identity Center administrator;
  management-account access used only for delegated-administrator setup.
- Region: `eu-central-1`
- Source revision: `6a1fdd3`
- Stack revision: issue #71 branch; final revision recorded by the PR.
- Teardown owner: engineer who ran the checkpoint.

## Offline checks

| Check | Result | Redacted note |
| --- | --- | --- |
| Workspace build | Pass | Checkpoint workspace compiled with TypeScript. |
| Focused Jest tests | Pass | 4 suites and 14 tests passed after live-discovered corrections. |
| Workspace boundary validation | Pass | Dependency direction is valid. |
| Offline synth and template review | Pass | Fake-account synth confirmed the runbook contract. |

## Live results

| Evidence | Result | Redacted note |
| --- | --- | --- |
| Provider role can write assigned valid prefix | Pass | Firehose delivered one encrypted Parquet object. |
| Canonical JSON converts to Parquet | Pass | Object used SNAPPY-compressed Parquet and the expected schema. |
| Region/account/day partition is exact | Pass | Object appeared only under the configured Region, workload account, and UTC event day. |
| Security Lake/Athena can query expected fields | Pass | Athena matched the expected Authentication event; 418 bytes were scanned. |
| Stable submitted IDs reconcile with queryable IDs | Pass | The one valid submitted event matched the one queryable event. |
| Malformed input stays outside valid dataset | Pass | The malformed record never appeared under the valid hierarchy. |
| Error-prefix delivery behavior is understood | Fail | Firehose could not write the sibling prefix because the generated provider role implicitly denied it. The exact-prefix `s3:PutObject` remediation passed the separate retest below. |
| Event-to-query delay is acceptable | Inconclusive | A controlled manual crawler run made the event queryable within the session; this does not establish production latency. |

Record aggregate counts only:

| Submitted | Firehose accepted | Valid Parquet | Quarantined | Queryable |
| ---: | ---: | ---: | ---: | ---: |
| 2 | 2 | 1 | 0 | 1 |

## Focused quarantine retest (2026-10-01)

Retested the merged remediation from PR #74 with a fresh custom source and two
fresh synthetic event IDs. The engineer explicitly delegated execution and
teardown to AI, with private journaling and checkpoint reports. The renewed
window was two hours; no budget-alert installation was claimed.

| Evidence | Result |
| --- | --- |
| Submitted / accepted encrypted | 2 / 2 |
| Valid Parquet rows | 1; every submitted field matched the decoded row. |
| Malformed rows in valid Parquet | 0 |
| Quarantined malformed records | 1; decoded raw payload exactly matched the submitted malformed event. |
| Observed failure classification | `DynamicPartitioning.MetadataExtractionFailed` |
| Catalog target | Exact valid source location; excludes the sibling quarantine prefix. |

This closes the observed sibling-prefix write-permission failure. It proves
metadata-extraction failure delivery, not every possible conversion failure.
Athena was not rerun; the earlier queryability result remains separate evidence.
EventBridge routing and production latency remain unproven by this retest.
A zero-byte placeholder was excluded from valid delivery counts. Two transient
read-only S3 polling failures recovered without resubmitting either event.

## Initial experiment cleanup inventory

| Resource type | Expected remaining | Observed remaining |
| --- | ---: | ---: |
| Firehose delivery stream | 0 | 0 |
| Conversion Glue database/table | 0 | 0 |
| Delivery log group/stream | 0 | 0; delivery logging was disabled. |
| Provider-role inline policy | 0 | 0; the custom-source role was removed with the source. |
| Temporary custom source | 0 | 0 |
| Experiment-only objects or crawlers | 0 | 0 |
| Experiment stacks and Athena workgroup | 0 | 0 |
| Retained Security Lake event resources | 0 | 0 |

The durable audit account, delegated-administrator registration, CDK bootstrap,
and AWS service-linked roles remain as account foundation. One protected Lake
Formation service-linked role retained stale policy text naming the deleted
bucket. Its data-location registration and bucket are absent, it is non-billable,
and AWS rejects direct modification of the protected role.

## Retest cleanup verification

Completed at 12:39 CEST on 2026-10-01, before the renewed 14:13 CEST deadline.
The retest stacks, roles, source, crawler, Glue databases/tables, Firehose stream,
Lambda/mapping, EventBridge rule, queues, synthetic objects, and lake bucket
were removed. No data lakes or Lake Formation registrations remain. Lake
Formation settings match the pre-retest snapshot.

CDK bootstrap, the default Athena workgroup, account foundation, and AWS
service-linked roles remain. A pre-existing metastore CloudWatch log group
predates the retest and was preserved; it can retain storage cost. The source
listing API reports Security Lake disabled after teardown; successful source
deletion was recorded before disablement.

Raw commands, outputs, payloads, and content verification remain in the ignored
`movie-platform-environments/.local/security-lake-quarantine-retest/` directory,
with the execution journal in that repository's `.local/security-lake-live-journal.md`.

## Decision

- Outcome: valid conversion and scoped sibling quarantine delivery both passed.
  The initial missing quarantine permission is corrected.
- Option A accepted or rejected: accepted as the basis for the reusable design,
  within the tested scope and limitations above.
- Required architecture changes: attach only `s3:PutObject` on the exact sibling
  error-object prefix to the Security Lake provider role, retain the separate
  conversion-schema role and Lake Formation grants, and keep delivery logging
  disabled until it has a separately authorized role.
- Follow-up issue or PR: issue #71 contains the remediation and evidence. The
  focused retest closes the quarantine delivery gate; PR 5 still needs its own
  offline routing, IAM, lifecycle, and construct tests.

Future delivery validation should combine a synthetic post-deploy canary with a
real test-tenant smoke action. Both must reconcile a unique event or correlation
ID in Athena with a bounded timeout; pull-request checks remain offline.
