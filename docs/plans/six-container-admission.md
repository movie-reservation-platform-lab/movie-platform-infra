# Implementation Plan: six-container admission permissions

## 1. Summary

Issue #51: expand exact ECR destinations for the existing admission role, without changing trust or deployment authority.

## 2. Goals

Support the six runnable containers accepted by the environment admission profiles.

## 3. Non-goals

No AWS deployment, repository creation/deletion, lifecycle change, static OCI admission, new role, or environment selection.

## 4. Current State

lib/github-oidc-trust-stack.ts selects only reservation-service from the six-entry artifact-foundation catalog. test/github-oidc-trust.test.ts checks exact claims, ECR actions and separate bootstrap role assumption.

## 5. Requirements and Assumptions

The operator requested cross-repository parity PRs, not live cloud changes. Existing GitHub Environment approval and OIDC conditions remain exact. Whether the evidence-reader App has been installed for each producer must be checked during operator rollout.

## 6. Proposed Design

Maintain an explicit admission component allowlist; look up destination names in the infra-owned catalog. Fail synth if a reviewed entry is missing. Map each to a concrete account/region ECR ARN in the existing repository statement. New catalog entries do not automatically receive admission permissions.

## 7. Alternatives Considered

A repository wildcard is simpler but too broad: rejected. Granting every catalog entry automatically risks future unintended expansion: rejected. Explicit component selection with catalog-owned names is chosen.

## 8. API / Interface Changes

No CDK config or output changes. Existing role and statement identity remain stable.

## 9. Data Model / Persistence Changes

None. Five existing ECR repositories become authorized destinations once an operator deploys this change.

## 10. Security, Privacy, and Abuse Considerations

Only the existing seven read/upload actions are granted. GetAuthorizationToken retains the service-required wildcard. No delete/admin actions, producer AWS trust, credentials or private account data enter this public PR.

## 11. Performance, Scalability, and Reliability Considerations

No runtime resources or recurring cost added. Synth fails on a missing approved catalog entry. Admission remains serialized and approval-controlled in environments.

## 12. Implementation Steps

1. Update addAdmissionPermissions and its role description.
2. Assert the exact six synthesized resource ARNs, unchanged actions, no broader authority.
3. Add operator rollout notes; run build, CDK tests and offline synth.

## 13. Testing Strategy

npm ci; npm run build; npm run test:cdk; npm run synth:github-oidc-trust. Existing tests cover exact OIDC conditions and deployment role separation. New IAM assertions use a fake account.

## 14. Rollout / Migration Plan

Coordinate with movie-reservation-platform-lab/movie-platform-environments#82. Review and merge independently. An operator later runs preflight/diff and deploys only GitHubOidcTrustStack using private configuration. Run each producer's protected admission only after its evidence workflow and environment consumer are merged. Roll back this policy if necessary; no image/data deletion.

## 15. Risks and Mitigations

Wrong destination: explicit list plus exact ARN assertion. Unexpected trust broadening: unchanged trust assertions. First live admission failure: report it; do not weaken scanning or IAM gates.

## 16. Done Criteria

Scoped public diff, green offline checks and PR linked to #51. Live deployment/acceptance explicitly outstanding.

## 17. Review Checklist

- [x] Requirements, boundaries, alternatives and rollback recorded.
- [x] No sensitive configuration or live mutations.
- [x] Build, all 52 CDK tests and offline trust synth passed; independent review completed.

## 18. Handoff Prompt for Implementation Agent

Implement this plan in lib/github-oidc-trust-stack.ts and test/github-oidc-trust.test.ts. Preserve role trust, output identities, existing actions and deployment-role permissions. Update operations notes and run the checks above. Do not deploy or dispatch admission.
