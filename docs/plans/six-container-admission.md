# Implementation Plan: six-container admission and runtime compatibility

## 1. Summary

Issue #51: expand exact ECR destinations for the existing admission role, without changing trust or deployment authority.

Refreshed on 2026-09-15 for PR #52 against merged producer and environment
contracts. The implementation still needs the same six ECR destinations; the
refresh updates rollout documentation, role-isolation coverage and CI enforcement,
and aligns ECS health commands with the newly minimized Python runtime images.

## 2. Goals

Support the six runnable containers accepted by the environment admission profiles.
Keep ECS health checks compatible with the currently published Python images.

## 3. Non-goals

No AWS deployment, repository creation/deletion, lifecycle change, static OCI admission, new role, or environment selection.

## 4. Current State

On infra main, `lib/github-oidc-trust-stack.ts` selects only reservation-service
from the six-entry artifact-foundation catalog. PR #52 adds an explicit six-entry
allowlist. `test/github-oidc-trust.test.ts` checks exact claims, ECR actions and
separate bootstrap role assumption, but `.github/workflows/ci.yml` currently omits
this test suite and the offline trust synth.

Cross-repository inspection (fetched main refs, 2026-09-15):

- Environment PR #84 delivered all-six admission; PR #97 (`ae08100`) activates
  hosted v1alpha3 for the five non-pilot producers after current-policy work in
  PRs #88–#93. PR #95 adds read-only vulnerability diagnostics. The pilot remains
  v1alpha1. The workflow identity and protected admission environment are preserved.
- Shared actions PR #13 (`bb40579`) delivers governed vulnerability exemptions.
  The five producers pin its full revision for v1alpha3 evidence.
- Producer main revisions: reservation-service `d818863` (pilot), reservation-web
  `aba0d34`, reservation-agent `41a8f6b`, reservation-mcp `f04acb0`,
  recommendation-service `4301630`, recommendation-mcp `7b56272`.
- The reservation-agent and both MCP production images removed `curl` and now
  publish Python `urllib.request` health checks. Infra still overrides these with
  `curl`, which would mark the current images unhealthy and block the task's
  health-gated startup. Ports, routes and startup dependencies are unchanged.
- The hosted profile selects evidence versions before download. V3 admission
  needs the original four-file package, protected receipt and a separate
  Contents-read policy App; it checks current policy before registry access.
  These are environment-owned gates, not new AWS permissions.
- Infra main `8555ff8`, already an ancestor of #52, includes PRs #47–#49. The
  current `ai/46-hybrid-teaching-guidance` branch's `.ai/` and `AGENTS.md` files
  match #52 exactly. No guidance changes remain to cherry-pick.

## 5. Requirements and Assumptions

The user requested updating #52 for sibling-repository changes and incorporating
the current branch. Existing GitHub Environment approval and OIDC conditions
remain exact. App installations, protected environment settings and deployed IAM
are live prerequisites to verify during operator rollout; they are not established
by this source review. No open design question blocks the repository update.

## 6. Proposed Design

Maintain an explicit admission component allowlist; look up destination names in the infra-owned catalog. Fail synth if a reviewed entry is missing. Map each to a concrete account/region ECR ARN in the existing repository statement. New catalog entries do not automatically receive admission permissions.

## 7. Alternatives Considered

A repository wildcard is simpler but too broad: rejected. Granting every catalog entry automatically risks future unintended expansion: rejected. Explicit component selection with catalog-owned names is chosen.

Adding vulnerability-policy logic to CDK would duplicate the environment-owned
decision and cannot enforce per-candidate checks in this IAM statement. Keep that
logic in the consumer; document the integration boundary here.

## 8. API / Interface Changes

No CDK config or output changes. Existing role and statement identity remain stable.
The agent and MCP task-definition health commands change from shell/curl to
exec-form Python HTTP checks using the same ports and routes.

## 9. Data Model / Persistence Changes

None. Five existing ECR repositories become authorized destinations once an operator deploys this change.

## 10. Security, Privacy, and Abuse Considerations

Only the existing seven read/upload actions are granted. GetAuthorizationToken retains the service-required wildcard. No delete/admin actions, producer AWS trust, credentials or private account data enter this public PR.

## 11. Performance, Scalability, and Reliability Considerations

No additional runtime resources or recurring cost added. Synth fails on a missing
approved catalog entry. Admission remains serialized and approval-controlled in
environments. Python probes remove the dependency on a deleted runtime tool;
their two-second HTTP timeout remains below ECS's existing five-second timeout.

## 12. Implementation Steps

1. Preserve `addAdmissionPermissions`, its exact six destinations, role identities
   and action set; these already match the current consumer.
2. In `test/github-oidc-trust.test.ts`, verify each policy's actual role attachment
   and complete statement inventory, and reject a missing approved catalog entry.
3. In `.github/workflows/ci.yml`, run the existing OIDC test and offline synth
   scripts so PR checks enforce this permission boundary.
4. Update `README.md`, the operations index and the admission runbook for the
   pilot/v3 split, merged dependencies, separate policy-reader access, current
   vulnerability decisions, evidence retention and safe rollback.
5. Replace agent/MCP `curl` probes in `lib/infra-stack.ts` with the producers'
   exec-form Python standard-library probes, with a two-second HTTP timeout.
   Update `test/infra.test.ts` and `docs/operations/temporary-integrated-demo.md`.
   Keep existing ECS timing, ports and health-gated startup dependencies.
6. Run focused OIDC/workload tests, build and offline synth, then `npm run ci`; inspect the
   final diff, push #52's branch and refresh its description with actual results.

## 13. Testing Strategy

Run `npm run test:cdk:github-oidc-trust`, `npm run test:cdk:workload`,
`npm run build`, `npm run synth:github-oidc-trust` and `npm run synth:ecr-contract`,
followed by `npm run ci`. IAM assertions use a
fake account and remain independent of sibling checkouts, GitHub and AWS.
Inspect the current branch guidance diff and CI wiring as part of review.
Check the Python HTTP probe against a local success response, HTTP failure and
timeout. This proves probe behavior, not a deployed image's health.

## 14. Rollout / Migration Plan

Environment issue #82 was delivered by #84, and hosted v3 activation is merged
in #97. Review and merge this PR independently. An operator later runs
preflight/diff and deploys only GitHubOidcTrustStack using private configuration.
Check both App installations and select a fresh canonical publication with
retained evidence before protected admission. Coordinate rollback with queued,
pending and active admissions before removing the five additional IAM destinations;
do not delete images or infer that cancellation undoes transfers.

The health-command change belongs to a later, separately approved workload
deployment with reviewed image digests. Do not include that workload change in
the trust-only IAM rollout. An older synthesized assembly still contains `curl`
probes; prepare and review a fresh assembly when adopting these runtime images.
An image rollback must use an assembly with health commands supported by those
images; the Python probe also works in the previous Python runtimes.

## 15. Risks and Mitigations

Wrong destination: explicit list plus exact ARN assertion. Unexpected trust broadening: unchanged trust assertions. First live admission failure: report it; do not weaken scanning or IAM gates.

## 16. Done Criteria

Scoped public diff, green offline checks and PR linked to #51. Live deployment/acceptance explicitly outstanding.

## 17. Review Checklist

- [x] Requirements, boundaries, alternatives and rollback recorded.
- [x] No sensitive configuration or live mutations.
- [x] Original PR validation: all 52 CDK tests and offline trust synth passed;
  independent review completed at that revision.
- [x] Refreshed validation: `npm run ci` passed (258 tests, five offline synth
  contracts, smoke/dashboard/image checks and Docker audit-router validation).
  After the health-command edit, build and all 26 workload tests also passed;
  workload synth in the full run contains all three Python commands.
- [x] All three Python probes passed local success, HTTP-error and timeout checks.
- [x] Reviewed CI wiring, exact six consumer destinations, producer runtime
  contracts and current-branch guidance parity; `git diff --check` passed.

## 18. Handoff Prompt for Implementation Agent

Implement the refreshed plan in `lib/github-oidc-trust-stack.ts`,
`lib/infra-stack.ts`, their tests and `.github/workflows/ci.yml`. Preserve role
trust, output identities, existing actions, deployment-role permissions and
health routes/timings. Update operations notes and run the checks above.
Do not deploy or dispatch admission.
