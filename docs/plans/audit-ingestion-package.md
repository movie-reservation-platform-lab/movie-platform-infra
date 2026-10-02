# Implementation Plan: Reusable Audit Ingestion Package (PR 5)

Status: implementation and repository verification complete. Quarantine live
delivery gate passed on 2026-10-01.
Parent: #42. Feasibility: #71 and PR #74. Future automated verification: #75.

## 1. Summary

Introduce `packages/audit-ingestion` as a reusable CDK construct package for the
central EventBridge-to-Firehose ingestion path. Use the successful conversion
experiment and focused quarantine retest as evidence.

## 2. Goals

- Own the bus, archive, routing rules, target DLQs, Firehose, conversion schema,
  scoped permissions, quarantine configuration, metrics, and typed outputs.
- Consume the pinned audit contract without reading a sibling repository during
  build or synth.
- Keep application configuration and operational automation outside the package.

## 3. Non-goals

No deployment, account creation, Security Lake enablement, native CloudTrail
composition, workload connectivity, service changes, or smoke-runner automation.
Those belong to subsequent slices. Do not add a provisioning Lambda implicitly.

## 4. Current State

`packages/audit-ingestion` now contains the reusable bus, archive, account-bound
rules, target DLQs, Firehose streams, conversion schema, scoped permissions,
metrics and typed outputs. The implementation extracts the proven conversion
schema role, Lake Formation DESCRIBE grants, UTC event-day partition and sibling
error prefix from the feasibility app.
The additional error-prefix write policy passed offline checks and a focused
live retest: one valid Parquet row and one exact malformed payload in quarantine. See `evidence/security-lake-firehose-feasibility.md`.
The existing experiment used direct Firehose publication; it did not prove the
EventBridge routing path. `apps/audit-account` remains the future composition root.

## 5. Requirements and Assumptions

Use the released Authentication contract, strict source/detail-type matching,
stable event IDs, explicit account routing, bounded retries and retention, and
exact IAM resources. Ordinary PR checks remain offline.

Resolved or deliberately deferred API boundaries:

- One rule and stream per workload account bind the trusted EventBridge account
  field to a fixed destination partition without changing the OCSF payload.
- The app remains responsible for lifecycle, encryption and reader restrictions
  on the externally managed lake bucket.
- The package exposes bounded CloudWatch metrics and does not configure Firehose
  delivery logging through the provider role whose boundary blocked it live.

## 6. Proposed Design

Expose a direct CDK construct, with typed props for producer bindings, source
destination details, retention, encryption dependencies and delivery settings.
Do not read environment variables, CDK context or AWS state inside the package.

Recommend one account-specific routing rule and delivery stream per workload
account initially. Match the EventBridge envelope account and supported event
contract, then forward only `detail.event`; the stream supplies the configured account
and Region partitions. Review this against the exact producer contract before
implementation. The bus resource policy and workload permission wiring remain
explicit app responsibilities in PRs 6 and 7.

The app supplies the existing custom source and provider role. The package owns
conversion resources and its additional scoped policies, not custom-source API
creation/deletion. Keep operational commands under `automation/`.

## 7. Alternatives Considered

- One stream per account: clear source attribution without changing the payload;
  more streams and smaller buffers. Recommended for the small account allowlist.
- Shared stream with a transport envelope: fewer resources, but requires an
  agreed account extraction and envelope removal mechanism. Defer until that
  processing contract is demonstrated; do not silently introduce a transformer.

## 8. Interfaces

Public exports are `AuditIngestion`, `AuditIngestionProps`, producer/source
binding interfaces, the event bus/archive, per-producer rule/stream/DLQ handles,
and bounded metric handles for app-level alarm composition.

## 9. Persistence

Preserve the released JSON and Parquet schema and UTC event-day semantics.
Retain stable `metadata.uid` through replay. Quarantine is raw, potentially
sensitive input and must remain outside the query dataset.

## 10. Security

Use exact stream, table and prefix permissions. Keep schema access separate from
the Security Lake destination role. Encrypt archive/DLQ/error storage, bound its
retention, and exclude raw input from normal query roles and published evidence.
A routing rule is not schema validation or a substitute for bus authorization.

## 11. Reliability

Configure explicit EventBridge retry/DLQ behavior and archive retention. Expose
delivery, throttling, freshness and target-failure metrics without event-ID metric
dimensions. Account-specific buffering increases cost/resource count; measure
before broadening the account allowlist. Delivery/replay can produce duplicates.

## 12. Ordered Implementation Steps

1. Quarantine gate completed: see the focused retest in the evidence record.
2. Completed: scaffold package manifest, exports, TypeScript/Jest configuration and README
   under `packages/audit-ingestion`; add package build/test to existing CI groups.
3. Completed: place the pinned contract, provenance checks and conversion helpers inside the
   reusable boundary. Add an explicit contract-vendor command under `local-tools/`
   or `scripts/`; normal builds must never fetch mutable upstream content.
4. Completed: add the construct, account bindings, bus/archive/DLQ, Firehose conversion and
   IAM resources. Prove resource scoping and deletion behavior in fixture stacks.
5. Completed: engineer implemented the routing rule and focused assertions after agreeing to
   the ownership card. AI reviews behavior before style, one issue at a time.
6. Completed: add typed outputs/metrics and synth fixtures. Keep PR 6 account composition
   separate; use fixtures to demonstrate package consumption.

## 13. Testing

Test matching and nonmatching event examples, emitted rule patterns, detail-only
target payload, DLQ/retries, IAM scoping, partitions, quarantine, encryption and
deletion policies. Include provenance verification and independent offline synth.
Run package build/test, workspace validation, `git diff --check`, then `npm run ci`.
No live AWS action is part of those commands.

## 14. Rollout and Quarantine Retest

The focused retest passed on 2026-10-01. The engineer explicitly delegated its
execution and teardown to AI, with checkpoint reports and private journaling.
For a future live session, reconfirm target/profile, budget, execution window,
teardown owner, and who executes mutations. Keep raw output in environment `.local`.
The procedure used for this gate was:

1. Inspect actual state and prior cleanup; do not assume a data lake still exists.
2. Recreate only reviewed prerequisites, source and corrected ingestion stack.
   Review each change set and the exact sibling-prefix write grant.
3. Publish one fresh valid event and one malformed synthetic event with distinct
   identifiers. Acceptance alone is not delivery evidence.
4. Prove valid delivery and malformed quarantine delivery, and prove malformed
   input is absent from the valid dataset. Inspect crawler targets to verify
   quarantine exclusion. Record bounded timing and aggregate counts privately.
5. Tear down experiment resources, inventory retained artifacts and update the
   redacted result. If delivery fails, revise the design before freezing PR 5.

Merging this plan performs no AWS operation. The reusable package is composed
and deployed only in later slices. Reverting an unused package has no live effect.

## 15. Risks

| Risk | Mitigation |
| --- | --- |
| Offline IAM assertions mistaken for live proof | Preserve the completed quarantine retest evidence; retest material permission changes. |
| Wrong account attributed to events | Match trusted envelope account and configure per-account delivery. |
| Quarantine included in crawl/query | Inspect live crawler target and test prefix separation. |
| Hidden ownership of an external bucket or role | Document app/package ownership in props and README. |
| Contract copies drift | Pin provenance and check hashes; update explicitly. |

## 16. Done Criteria

Quarantine gate passed; package independently builds/tests/synthesizes; dependency
direction holds; IAM/retention/routing contracts have tests; app and automation
boundaries remain explicit; engineer-owned work is reviewed and explained.

## 17. Hybrid Ownership Card (Agreed)

- Learning target: translate an audit routing contract into an EventBridge rule
  and focused CDK assertions.
- AI owns: package scaffolding, extraction, IAM, conversion, lifecycle/metrics
  plumbing, documentation, research and verification.
- Engineer owns: the Authentication routing rule and its tests, including which
  events match and forwarding the OCSF detail only; short teach-back after review.
- Likely files: `src/authentication-routing.ts` and
  `test/authentication-routing.test.ts` inside `packages/audit-ingestion`.
- Done evidence: matching/nonmatching examples and synthesized target/rule
  assertions pass, then full repository checks pass.
- Support level: guided. Engineer agreed to this slice in the planning session.

## 18. Handoff

Implement only PR 5 after the ownership agreement and technical gates above.
Read the parent plan's PR 5 boundary. Do not import from deployable apps, mutate
AWS, change the service contract, or implement the engineer-owned slice on their
behalf. Stop and revise this plan if the retest changes the destination design.
PR 9 owns the two-phase live smoke; #75 extends it with scheduled/post-deploy
execution and test-tenant verification.
