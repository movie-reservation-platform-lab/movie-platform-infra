# Experiment sandbox contract

The infrastructure app, trusted operator and Harness trial tool share this
small private workspace. It contains only data validation and policy, with no
filesystem, AWS SDK, process or application imports. Its one runtime
dependency is `zod`: the record schemas in `src/sandbox-record.ts` are the
single source of truth, and the TypeScript types are inferred from them.
Consumers that copy compiled files instead of bundling (the trial tool's
Dockerfile) must copy `node_modules/zod` too.

`SANDBOX_LIMITS` (`src/sandbox-limits.ts`) holds every fixed limit: region,
budget ($8 operating, $2 contingency, $10 allowance), lease length, new-work
cutoff, cleanup window, launch caps and evidence age. The record schema, the
admission policy, the CDK app, the launcher and the trial tool all import it.
The limits are deliberately not record fields: the record is hand-edited, so
raising a budget must be a reviewed code change.

`parseSandboxRecord(unknown)` validates JSON at runtime, rejecting unknown keys,
wrong accounts, mutable/equal image references, unsupported regions, invalid
lease/task caps and malformed evidence. TypeScript interfaces alone cannot
validate a file loaded from disk. Every timestamp must be UTC ISO 8601 with a
trailing `Z` (for example `2026-10-24T10:00:00Z`, the output of
`toISOString()`); values without a zone, with an offset, or with impossible
dates are rejected. `isUtcTimestamp` exposes the same check to hand-written
validators.

`allocationBlockers(record, now)` keeps current artifact verification,
zero-charge Harness entitlement (the plan is free through lease expiry), a
complete cost forecast within the limits, organization capacity and
independent account-recovery evidence separate. `admissionBlockers` also
requires the ready sandbox, a started lease, verified protected cleanup and
unfinished inventory. Both validate the record once and apply rules to the
parsed copy. `assertAdmission` throws on those blockers. Neither a local
attestation nor these functions establishes that a live AWS guardrail was
deployed. The operator verifies deployed schedule, outputs and notification
subscription before installing an admission lease.

`isDigestImageReference` is the shared immutable image syntax check. The CDK app
owns its narrower synth-input contract and independently validates rendered
configuration; the operator and trial tool never import deployable app code.

Tests: `test/admission-policy.test.ts` changes one field of an approved record
per case and expects exactly one blocker; `test/sandbox-record.test.ts` covers
timestamps, lease bounds, caps, images, accounts and the retired-control
manifest. No live calls are made.
