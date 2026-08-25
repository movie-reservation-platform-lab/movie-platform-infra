# AWS Demo Release Checklist

Use this checklist to release the standalone-account AWS demo in two deliberate
gates. Gate 1 delivers reviewed repository changes without touching AWS. Gate 2
is a separately approved, supervised rehearsal against the real account.

The detailed procedures remain authoritative:

- [Standalone-account access bootstrap](./standalone-account-access-bootstrap.md)
- [AWS artifact-foundation runbook](./aws-artifact-foundation.md)
- [Temporary integrated AWS demo runbook](./temporary-integrated-demo.md), which
  controls foundation expansion, six-image selection, deployment, acceptance,
  and teardown for this release

Do not treat completion of Gate 1 as permission to start Gate 2.

## Gate 1: Repository Delivery

- [ ] PRs 1–4 from the
      [approved plan](../plans/standalone-account-identity-center-bootstrap.md)
      were reviewed and merged in order.
- [ ] PRs 1–5 from the
      [artifact-foundation plan](../plans/persistent-ecr-artifact-foundation.md)
      were reviewed and merged in order.
- [ ] The release checkout is based on the resulting `main`, with no unrelated
      local changes.
- [ ] `npm ci` completed from the repository root.
- [ ] `npm run ci` passed without AWS credentials or live AWS account/API
      lookups; both offline synth contracts used `--no-lookups`.
- [ ] GitHub Actions reported the account-preflight and artifact-cleanup
      `automation` job before the `infra` and `tooling` jobs, and ran both
      offline synth contracts only after those jobs passed.
- [ ] The reviewed repository diff contains no unapproved CDK deployment-
      contract change.
- [ ] The reviewed files contain no real account ID, personal email, SSO URL,
      generated role name, token, access key, credential, or private target
      file.
- [ ] Expected AWS cost, billable-resource lifetime, and the teardown owner are
      understood.
- [ ] No `aws`, `cdk bootstrap`, `cdk deploy`, or `cdk destroy` operation was
      used to complete this gate.

Gate 1 is complete only when every item above passes. Stop here and request
explicit approval for the live rehearsal.

## Gate 2: Explicitly Approved AWS Acceptance Rehearsal

Record only sanitized pass/fail evidence outside Git. Do not record complete
account IDs, role ARNs/suffixes, SSO URLs, email addresses, or session data.

### Access foundation

- [ ] Explicit approval for this real-account rehearsal is recorded.
- [ ] The relevant controlling runbook's journal exists under `.local/`,
      `git check-ignore` confirms it is ignored, and only sanitized outcomes
      will be recorded there.
- [ ] Root recovery and MFA are verified, and root is not used for routine
      deployment work.
- [ ] The access bootstrap runbook is complete through the dedicated
      `movie-platform-demo` profile and private `aws-target.json`.
- [ ] `aws sso login --profile movie-platform-demo` succeeds.
- [ ] `npm run preflight:aws` passes with the expected redacted account, Region,
      permission-set, and role result.

### Foundation and deployment

- [ ] The local offline verification in the deployment runbook passes again
      from the exact release checkout.
- [ ] `ArtifactFoundationStack` is deployed through Gate 1 of the integrated
      runbook; termination protection, retain policies, all six repository
      outputs/settings, lifecycle rules, and ownership tags are verified.
- [ ] Gate 2 resolves six exact approved GHCR source digests. Reservation service
      retains its generalized admission result; the other five candidates use
      the reviewed temporary copy-and-verify path. Sanitized evidence records
      matching source and destination digests without committing target values.
- [ ] The preflight passes immediately before creating or changing the ingress
      prefix list; its owner, Region, IPv4 family, capacity, and reviewed `/32`
      entries are verified afterward.
- [ ] The preflight passes immediately before the one-time CDK bootstrap, and
      the intended account/Region are supplied explicitly.
- [ ] CDK synth and diff are reviewed with the exact prefix-list ID and all six
      exact private-ECR `destinationImageReference` plus `deploymentVersion`
      pairs from the environment release.
- [ ] The preflight passes again immediately before deployment.
- [ ] `MovieReservationWorkloadStack` deploys successfully, and its expected billable
      resources become healthy.

### Workload and Grafana acceptance

- [ ] Workload health, integrated happy/slow/error scenarios, and the X-Ray and
      managed-metrics smoke checks pass.
- [ ] The preflight passes before the Managed Grafana access changes.
- [ ] The named operator is assigned to the deployed workspace and promoted to
      Admin only long enough to create and test the AMP, CloudWatch metrics/logs,
      and X-Ray data sources.
- [ ] The operator is downgraded to Editor, starts a fresh session, and can use
      dashboards and Explore without being able to manage data sources.
- [ ] The repository dashboard is imported only after the final Editor state is
      verified.

### Teardown and privilege exit gate

- [ ] The preflight passes immediately before `cdk destroy`.
- [ ] `MovieReservationWorkloadStack` and its ALB, ECS tasks/service, AMP workspace,
      Managed Grafana workspace and assignment, role, VPC endpoints, and log
      groups are gone.
- [ ] `ArtifactFoundationStack`, its admitted images, `CDKToolkit`, the ingress
      prefix list, Organization, Identity Center instance, operator and MFA,
      and local profile/target still exist and remain usable.
- [ ] A separately reviewed least-privilege deployment permission set is active
      and tested; the local profile and private expected role are updated and
      the preflight passes with them.
- [ ] The temporary `AdministratorAccess` account assignment is removed before
      any second workload deployment.

If any checkpoint fails, stop at that checkpoint. Safely remove billable
workload resources when possible, preserve the identity foundation unless it is
the source of the failure, and use a focused corrective PR plus new rehearsal
approval. The release is complete only when all Gate 2 items pass.

Guarded artifact-foundation cleanup is not part of routine demo teardown. Use
it only for separately approved project retirement or the explicit issue #12
acceptance-and-redeploy sequence in the artifact-foundation runbook.
