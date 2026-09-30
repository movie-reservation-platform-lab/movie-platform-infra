# Delivered Plans

This folder keeps implementation plans after their owning issue or pull request
has landed. These are historical delivery records, not active implementation
instructions.

## Maintenance Rules

- Add a short status banner naming the delivered issue or pull request.
- Preserve rationale and rejected alternatives when they still explain the
  resulting architecture.
- Move unresolved work into a current plan, roadmap, ADR, runbook, or GitHub
  issue before archiving the original plan.
- Prefer current architecture and operations documentation when it differs from
  a delivered plan.
- Compact or delete a delivered plan after its durable knowledge is captured
  elsewhere and Git history is sufficient for the remaining detail.

## Index

- [Audit account foundation](./audit-account-foundation.md): independently
  buildable audit-account workspace and guarded account-targeting boundary.
- [Audit demo implementation](./audit-demo-2026-09-08.md): three-stack audit,
  observability and workload demo delivery plan.
- [Audit demo telemetry fix](./audit-demo-telemetry-fix.md): AMP/X-Ray telemetry
  correction from the audit-demo rehearsal.
- [GitHub OIDC trust roles](./github-oidc-trust-roles.md): separate admission
  and deployment entry roles.
- [Idempotent artifact verification mode](./idempotent-artifact-verification-mode.md):
  v2 copy/verify contract for immutable artifact admission.
- [Persistent ECR artifact foundation](./persistent-ecr-artifact-foundation.md):
  retained ECR foundation and artifact admission handoff.
- [Prefix-list ingress allowlist](./prefix-list-ingress-allowlist.md):
  externally owned prefix list for ALB and Grafana ingress.
- [PR #52 review and onboarding](./pr-52-review-and-onboarding.md): review
  findings and onboarding fixes for the integrated workload slice.
- [Reservation artifact copy mechanics](./reservation-artifact-copy-mechanics.md):
  exact GHCR-to-ECR manifest copy and verification.
- [Six-container admission and runtime compatibility](./six-container-admission.md):
  admission role expansion and compatibility with current producer images.
- [Standalone-account Identity Center and Grafana access bootstrap](./standalone-account-identity-center-bootstrap.md):
  original account access and Grafana bootstrap plan for issue #14.
- [Temporary integrated AWS demo](./temporary-integrated-aws-demo.md):
  six-application ECS demo expansion before the current audit split.
