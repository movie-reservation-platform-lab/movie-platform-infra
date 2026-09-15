# PR #52 review and onboarding improvements

## 1. Summary

Review revision `9e21f8f` using the four repository review-agent instructions,
then fix concrete correctness and comprehension findings in the PR and adjacent
code/documentation. This document records findings and their disposition.

## 2. Goals

Make the admission/workload changes understandable to a new maintainer and make
tests explain the contracts they protect. Address evidenced review findings.

## 3. Non-goals

No AWS mutation, admission dispatch, release selection, resource-ID renaming or
wholesale infrastructure redesign. Existing demo limitations are evaluated
separately from defects.

## 4. Current state

The PR expands six exact admission destinations, updates Python runtime health
checks, and adds OIDC validation to CI. Main documentation omits the trust stack
from its stack summaries; the plans index labels delivered work as future work.
The root README lists commands but lacks a code-and-test reading path.

## 5. Requirements and assumptions

The user explicitly requested all four review agents, a new-joiner assessment,
collected findings and fixes. Continue on PR #52's existing worktree and preserve
the user's original checkout. The configured `gpt-5.4` model is unavailable for
this account; run the same read-only agent instructions with the available model.

## 6. Proposed design

Use small local improvements: intention-revealing names, focused test cases,
explicit failure diagnostics and an onboarding map. Keep construct identities,
external contracts and the existing stack organization stable unless a confirmed
correctness finding requires a documented change.

## 7. Alternatives considered

A broad stack decomposition would change many unrelated lines and risk resource
identity drift. Prefer focused helpers only for real repeated behavior. A
documentation-only review cannot resolve unclear tests or actual defects, so
include code/test fixes where supported by evidence.

## 8. Interface changes

Valid configuration, default retention, construct IDs and output contracts stay
unchanged. Invalid retention types now fail instead of being coerced; missing
admission destinations identify the component. Managed-metrics smoke queries
use the reservation container identity and terminate a stalled AMP command within
the remaining metric budget. No new CLI options or AWS permissions are added.

## 9. Persistence changes

None.

## 10. Security considerations

Preserve exact trust and permission boundaries. Test fixtures remain synthetic.
No credentials, target bindings or generated cloud state enter public changes.

## 11. Performance and reliability

Keep probe timeouts, startup dependencies and policy scopes explicit. Distinguish
measured defects from the documented single-task demo's scaling limitations.

## 12. Implementation steps

1. Run security, maintainability, performance and system-design reviews; collect
   evidence and triage in the findings table below.
2. Add `docs/architecture/code-reading-guide.md`; link it from README/docs index;
   complete current stack maps and label historical planning material clearly.
3. Apply accepted code/test fixes in the admission and workload paths, adding
   focused regression coverage for behavior changes.
4. Run relevant checks, review the combined diff, obtain follow-up reviewer
   verification, then update PR #52.

## 13. Testing strategy

Use focused Jest suites while iterating, then the relevant full repository gate.
For structural-only changes, compare offline synthesized templates to ensure
resource identities and permissions did not change. Inspect documentation links
and commands against the repository. Tests must not require sibling checkouts.

## 14. Rollout and rollback

Publish the reviewed changes to the existing PR after validation. AWS rollout
remains an operator action. Revert the review commit to undo these improvements;
no deployed resources are modified during this work.

## 15. Findings and disposition

| ID | Finding | Source | Disposition |
| --- | --- | --- | --- |
| O1 | Stack summaries omit GitHub OIDC trust; no code/test reading path | Parent onboarding review: README, architecture index | Add stack entry and reading guide |
| O2 | Plans index presents delivered artifact/bootstrap/integrated-topology work as current priorities | Parent onboarding review: plans index | Label historical plans and link current architecture |
| O3 | README teardown still implies workload destruction removes independent foundations | Parent onboarding review: README teardown | Link current ordered cleanup and identify retained resources |
| R1 | Shared-task-role test promises applications cannot mutate AWS although telemetry/audit writes are shared | Maintainability: `test/infra.test.ts` | Name the real boundary and assert action arrays |
| R2 | Logging helper ignores its component argument, implying routing behavior it does not control | Maintainability: `lib/infra-stack.ts` | Use a no-argument typed log-driver factory; point to FireLens tag routing |
| R3 | Invalid trust configurations pass tests on any exception | Maintainability: `test/github-oidc-trust.test.ts` | Assert each expected diagnostic |
| R4 | Missing-destination error hides component identity; lookup spy tests mechanics, not catalog behavior | Maintainability: trust stack/test | Name missing component; use missing/extra catalog fixtures |
| P1 | Container Insights query uses ECS service name as container name; fixture conceals mismatch | Performance: managed-metrics script/test | Keep service and reservation container identities separate; assert dimensions |
| P2 | AMP subprocess can outlive the metric polling deadline | Performance: managed-metrics script | Bound subprocess by remaining deadline; exercise a stalled fake command |
| D1 | `Number(unknown)` silently accepts boolean/array audit retention values | System design: `foundation-config.ts` | Accept only numbers/nonblank strings and test runtime types and boundaries |
| D2 | ADOT comment omits startup readiness dependency | System design: workload stack/test | Distinguish startup gating from runtime nonessential behavior |
| D3 | Canonical CDK guidance calls ADOT the sole owned image asset | System design: `.ai/skills/aws-cdk-iac/SKILL.md` | Include audit-router and regenerate guidance |

## 16. Done criteria

All four instruction sets have run, findings have an explicit disposition,
accepted fixes pass relevant checks, and the PR contains the review record.

## 17. Review and verification status

- Security: complete; no material introduced findings. Exact OIDC/ECR scope and
  shared-task-role limitations were reviewed.
- Readability/maintainability: complete; R1–R4 accepted.
- Performance/scalability: complete; P1–P2 accepted, both existing tooling issues.
- System design/scalability: complete; D1–D3 accepted. No additional admission
  boundary or stack-dependency defect found.
- Focused follow-up reviews: maintainability and system design confirm their
  findings are resolved; performance confirms both fixes and requested a bounded
  self-exit in the stalled test fixture, which is included.
- Implementation: all 12 O/R/P/D findings addressed.
- Validation: `npm run build` and 80 focused tests passed. `npm run ci` passed
  with 280 tests, five offline synth contracts, smoke/image/dashboard checks and
  real Docker audit-router validation.
- The workload, trust and audit synthetic templates are identical to their
  pre-review versions at `9e21f8f`; valid configuration produces no resource or
  permission changes from these review fixes.
- Checked 34 relative documentation links, `git diff --check`, shell syntax and
  equality of canonical/generated CDK guidance after `.ai/sync.sh`.

The AMP process wrapper uses existing Node tooling rather than inventing an
unsupported `awscurl` option; see the upstream
[CLI options](https://github.com/okigan/awscurl#options).

### New-joiner assessment

The code is moderately approachable: explicit stack classes and input/result
types map directly to responsibilities. Configuration and artifact-copy tests
already explain useful contracts. The main friction was misleading names or
claims, broad exception assertions, stale navigation and missing guidance on
shared task permissions/startup behavior. Focused fixes and the linked reading
guide address these without a broad stack rewrite.

## 18. Handoff

Continue from the findings table, preserve public contracts and construct IDs,
and verify code and tests together. Read current architecture and operations
guides before treating an old implementation plan as current behavior.
