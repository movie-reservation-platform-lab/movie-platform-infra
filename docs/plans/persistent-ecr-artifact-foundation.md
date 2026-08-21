# Implementation Plan: Persistent ECR Artifact Foundation

> Issue: [#12](https://github.com/movie-reservation-platform-lab/movie-platform-infra/issues/12)
>
> Status: approved for implementation in five pull requests
>
> Decision review completed: 2026-08-21
>
> Current slice: PR 1/5, plan and decisions only

## 1. Summary

Provision the first application artifact repository as a small, persistent CDK
foundation that is independent from the disposable demo workload. The first
repository is named `movie-reservation-service`; later services can repeat the
same account-local and Region-local pattern after the second real consumer
proves which abstraction is useful.

The public infrastructure repository owns the ECR resource and its durable
configuration. The private `movie-platform-environments` repository will later
own artifact admission: selecting an approved GHCR digest, validating evidence,
copying that exact artifact to ECR, and recording sanitized release evidence.
The workload continues to consume an explicit, digest-pinned ECR reference.

This plan also introduces a guarded final-cleanup path. Routine demo teardown
must remain cheap and easy, while deleting the persistent artifact foundation
must require a separate, deliberate workflow. `CDKToolkit`, AWS Organizations,
IAM Identity Center, the operator identity, and root recovery controls are
outside project cleanup.

No AWS deployment, deletion, or other mutation is authorized during the five
implementation PRs. Live acceptance happens only after all five PRs merge and
each mutation group receives explicit approval.

## 2. Goals

- Create one ECR repository for `movie-reservation-service` in a dedicated
  `ArtifactFoundationStack`.
- Keep the repository available when `GoldenPathDemoStack` is routinely
  destroyed after a demo.
- Make accidental foundation deletion difficult and final cleanup possible,
  explicit, inspectable, and repeatable.
- Preserve the current digest-pinned workload contract.
- Keep public infrastructure configuration separate from private release and
  admission configuration.
- Make the design portable to future development, staging, and production AWS
  accounts without hardcoding account-specific resource identifiers.
- Give every implementation concern a focused offline test boundary.
- Keep each PR small enough for a human to understand and review.

## 3. Non-goals

- Refactoring `GoldenPathDemoStack` into smaller workload stacks. Its size is a
  known concern and should be handled by a separate issue.
- Creating repositories for the other five planned services.
- Building the GHCR-to-ECR admission workflow; that belongs to the private
  environments repository and its issues #13/#17.
- Adding GitHub OIDC, GitHub-held AWS credentials, cross-account roles,
  replication, or a central registry account.
- Creating a generic registry framework before a second repository provides a
  proven reuse case.
- Changing the current workload's application image parsing or digest contract.
- Adding an automated running-digest verifier; that remains part of issues
  #10/#13.
- Deleting `CDKToolkit` as part of project cleanup.
- Deleting or reconfiguring AWS Organizations, IAM Identity Center, the operator
  identity, or root-account recovery controls.
- Solving production retention, rollback windows, or legal/compliance retention.
- Modernizing unrelated documentation or legacy workload tags.

## 4. Current State

- [`bin/infra.ts`](../../bin/infra.ts) is the only CDK entrypoint. It requires
  workload-specific context before the app can synthesize.
- [`lib/infra-stack.ts`](../../lib/infra-stack.ts) defines the large,
  intentionally disposable `GoldenPathDemoStack`.
- [`lib/application-image.ts`](../../lib/application-image.ts) imports an ECR
  repository by name and creates an ECS image reference from an immutable
  digest. It does not create the repository.
- [`lib/config/platform-config.ts`](../../lib/config/platform-config.ts)
  validates the complete private ECR URI and requires its account and Region to
  match the deployment target.
- [`test/infra.test.ts`](../../test/infra.test.ts) deliberately asserts that the
  workload stack contains no `AWS::ECR::Repository` resource.
- Existing operations documentation starts with a pre-existing image reference
  and does not provide an infrastructure-owned repository bootstrap path.
- The approved cross-repository delivery model selects a portable GHCR candidate
  in the private environments repository, admits the exact digest to ECR, and
  supplies the resulting ECR digest reference to this repository.

The missing piece is therefore not the ECS image-consumption contract. It is the
persistent destination repository, its lifecycle boundary, its cleanup safety,
and the operational handoff to artifact admission.

## 5. Approved Requirements And Assumptions

### 5.1 Lifecycle and cost

- The artifact foundation and demo workload have different lifecycles and must
  be different CloudFormation stacks.
- Routine teardown deletes `GoldenPathDemoStack` and its billable demo resources
  but preserves `ArtifactFoundationStack` and `CDKToolkit`.
- Full project cleanup can delete the artifact foundation and its images through
  a separately guarded workflow.
- The initial lab model optimizes for the user's personal account and personal
  spend. Production would require a new retention and promotion review.
- Only untagged images older than seven days expire automatically. Tagged
  admitted artifacts remain until explicit final cleanup or a future approved
  retention design.

### 5.2 Artifact identity

- ECR tags are immutable, without mutable exclusions or convenience aliases.
- ECS deployments remain pinned to a `sha256` ECR digest.
- Human-readable evidence must map the release identifier, source revision,
  source GHCR digest, admitted ECR digest, requested ECS digest, and actual
  running digest.
- Issue #12 exposes repository identity and preserves machine-truth digests; it
  does not implement the later admission ledger or running-task verifier.

### 5.3 Account and Region

- The repository is account-local and Region-local. The current lab target is
  Europe (Frankfurt), `eu-central-1`.
- Logical development, staging, and production-demo stages may initially share
  the same lab repository because the account is still shared.
- When stages move into separate AWS accounts, the same foundation stack is
  deployed independently in each account and the exact approved candidate is
  admitted to each destination.
- Account IDs, concrete ECR URIs, role identifiers, SSO URLs, and live outputs
  must not be committed.

### 5.4 Access and trust

- Initial foundation deployment and artifact admission run from the local
  workstation using the MFA-backed IAM Identity Center profile.
- The temporary `AdministratorAccess` permission set is accepted for the first
  lab rehearsal. Least-privilege automation is future environments work.
- Issue #12 adds no GitHub AWS credentials, long-lived access keys, OIDC role,
  cross-account role, or broad ECR repository policy.
- The ECS task execution role receives only the pull access it already needs
  through the workload stack's imported repository.

## 6. Decision Log

| Topic | Approved decision | Why now | Revisit when |
| --- | --- | --- | --- |
| Stack ownership | Separate `ArtifactFoundationStack` | Artifact and workload teardown have different lifecycles | Workload stacks are split further |
| Routine teardown | Destroy workload; retain foundation and `CDKToolkit` | Stops demo costs without needless re-bootstrap or re-admission | Cost or account policy changes |
| Final cleanup | Guarded deletion of foundation and retained repository | The lab must be fully cleanable without making routine deletion dangerous | A central platform cleanup service exists |
| Deletion safety | Stack termination protection plus retained ECR resource | Two independent barriers reduce accidental data loss | Production retention is designed |
| Admission actor | Local MFA-backed SSO workstation | Smallest trustworthy starting point | Private environments automation is ready |
| Tag mutation | Immutable tags | Prevents a human label from silently changing its artifact | No planned relaxation |
| Deployment identity | Digest is machine truth; evidence supplies human context | Reproducible deployment without losing traceability | Release ledger design matures |
| Encryption | ECR AES-256 with AWS-owned/S3-managed encryption | No per-key operational overhead or KMS cost for the lab | Production repository is created |
| Scanning | Trivy is automatic gate; ECR basic scan is manual/on-demand | Avoids duplicate unclear gates | Inspector or ECR scan policy is approved |
| Retention | Expire only untagged images after seven days | Cleans interrupted copies without deleting admitted releases | Multiple active/rollback releases exist |
| Repository layout | One flat repository per deployable; create only the reservation service | Clear ownership and digest lookup | Second repository proves an abstraction |
| Cross-repo discovery | Foundation outputs resolved at runtime; no CFN/SSM coupling | Keeps desired release portable across accounts | Environment target registry is designed |
| CDK boundary | Separate CDK entrypoint and commands | Foundation can synth/deploy before an application image exists | Multiple apps justify CDK stages |
| Environment model | Repeat the same foundation in each future account | Straight path to account isolation | Central registry/replication is justified |
| Tests | Focused stack, automation, and synth suites | Failures remain attributable; scaffolding is tested | CI topology is redesigned |
| Automation language | TypeScript and AWS SDK for JavaScript v3 | Fits CDK repository and offers typed service clients | Tool moves to a dedicated automation repo |
| Resource tags | Platform, Service, Scope, Lifecycle, ManagedBy; no Environment | Repository is shared by logical stages today | Each stage gets an isolated account |
| Documentation | Dedicated runbook plus targeted cleanup of obsolete claims | One operational truth without unrelated churn | Stack topology is refactored |
| Live acceptance | Deploy, verify, prove guard, clean, redeploy after all PRs | Exercises both creation and safe deletion in reality | CI obtains a sandbox account |
| Delivery | Five sequential, human-sized PRs | Separates resource, observation, destruction, and operations review | Not applicable |

## 7. Proposed Design

### 7.1 CDK topology

Add a second, independent entrypoint:

```text
bin/artifact-foundation.ts
        |
        v
ArtifactFoundationStack
        |
        v
ECR: movie-reservation-service

bin/infra.ts
        |
        v
GoldenPathDemoStack
        |
        v
imports movie-reservation-service and consumes <repository-uri>@sha256:<digest>
```

Recommended source boundaries:

- `bin/artifact-foundation.ts`: creates the CDK app and foundation stack using a
  normal CDK `env` target.
- `lib/artifact-foundation-stack.ts`: defines the single repository, tags,
  outputs, and deletion behavior.
- `test/artifact-foundation.test.ts`: owns the foundation's CDK assertions.
- `bin/infra.ts`, `lib/infra-stack.ts`, and the existing workload tests keep
  their current responsibility.

Do not add fake workload inputs, a `deploymentScope` flag, or a direct
CloudFormation reference between the stacks. Separate entrypoints make the
foundation independently synthesizeable before any image has been admitted.

The stack ID is `ArtifactFoundationStack`. PR 2 should expose dedicated npm/CDK
commands so an operator cannot accidentally target both entrypoints with an
ambiguous command.

### 7.2 ECR repository configuration

The first repository is configured as follows:

| Property | Value |
| --- | --- |
| Repository name | `movie-reservation-service` |
| Image tag mutability | Immutable, with no exclusions |
| Encryption | AES-256 using the ECR default AWS-owned/S3-managed encryption |
| Automatic scanning | Scan-on-push disabled; manual ECR basic scans remain available |
| Lifecycle rule | Delete only untagged images whose age is greater than seven days |
| Empty-on-delete | Disabled |
| CloudFormation deletion policy | Retain |
| CloudFormation update-replacement policy | Retain |
| Stack termination protection | Enabled at deployment |

Use CDK retained-on-delete-and-replacement behavior (currently
`RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE`) so both synthesized policies are
intentional. The repository must not silently disappear when its stack is
deleted or a future change would replace the resource.

Apply these exact tags:

| Key | Value |
| --- | --- |
| `Platform` | `movie-reservation-platform` |
| `Service` | `movie-reservation-service` |
| `Scope` | `artifact-foundation` |
| `Lifecycle` | `persistent` |
| `ManagedBy` | `aws-cdk` |

Do not add an `Environment` tag while logical stages share the same repository.
AWS cost-allocation-tag activation may be documented, but it is not a deployment
requirement.

### 7.3 Stable outputs and handoff

The foundation exposes CloudFormation outputs for:

- repository name;
- repository URI; and
- repository ARN.

Recommended stable output names are:

- `MovieReservationServiceRepositoryName`;
- `MovieReservationServiceRepositoryUri`; and
- `MovieReservationServiceRepositoryArn`.

These are discovery outputs, not committed release configuration. The private
environments tooling resolves them for the selected AWS target at runtime. It
then copies an already approved GHCR digest into ECR and passes the complete
`<repository-uri>@sha256:<digest>` reference to the workload deployment.

Do not introduce a direct cross-stack reference or SSM parameter lookup. That
would couple the persistent foundation to a disposable workload and would make
future account separation harder.

### 7.4 Cross-repository ownership

This public repository owns:

- repository name and infrastructure configuration;
- deletion and retention safety;
- stable outputs;
- credential-free CDK assertions and offline synth;
- generic deployment, verification, and cleanup documentation; and
- generic cleanup automation that receives a validated local target.

The private `movie-platform-environments` repository owns:

- the allowlisted GHCR source repository;
- portable desired-release identity: GHCR registry/repository/digest, source
  revision, build reference, and human version;
- provenance, attestation, Trivy, and SBOM evidence checks;
- the exact GHCR-to-ECR copy;
- sanitized admission and deployment evidence; and
- later coordination of active, rollback, and retention-protected digests.

Secrets do not belong in either repository. Real target identifiers and raw AWS
outputs remain in local, gitignored operator state until a separately approved
private target-registry design replaces that boundary.

### 7.5 Cleanup safety model

Two cleanup modes must remain visibly different:

1. **Routine demo teardown** destroys `GoldenPathDemoStack`. It preserves
   `ArtifactFoundationStack`, its repository, admitted images, `CDKToolkit`, and
   account-level identity/governance.
2. **Final project cleanup** is a guarded automation workflow for the artifact
   foundation. It is never part of the routine workload command.

The final-cleanup workflow must:

1. Run the existing AWS account preflight for the exact SSO profile, account,
   Region, and expected role.
2. Refuse to continue while `GoldenPathDemoStack` exists.
3. Read and display the exact foundation stack, repository, image digests, tags,
   protection state, and intended operations.
4. Default to inspection/dry-run with no mutations.
5. Require an explicit execute flag and an exact, target-specific confirmation.
6. Disable termination protection on `ArtifactFoundationStack`.
7. Delete the foundation stack and wait for its terminal result. The ECR
   repository remains because of its retain policies.
8. Delete the exact retained repository and its images using the ECR API.
9. Verify that the stack and repository are both absent.
10. Preserve `CDKToolkit`, the customer-managed ingress prefix list unless its
    own runbook explicitly includes it, and all account identity/governance.

If repository deletion fails after the stack is gone, rerunning the tool must
recognize the retained/orphaned repository and safely resume cleanup. It must
not require recreating the stack merely to retry repository removal.

### 7.6 Cleanup automation boundary

Add cleanup as a standalone TypeScript automation building block, separate from
the CDK/business test suite. Use AWS SDK for JavaScript v3 clients for
CloudFormation and ECR rather than shelling out to the AWS CLI for service
operations.

The existing preflight remains TypeScript plus AWS CLI v2 because validating the
operator's configured CLI/SSO identity is its purpose. Cleanup must consume the
same validated profile and Region rather than falling back silently to ambient
credentials.

The building block must have:

- its own `tsconfig.json`, Jest configuration, package boundary, and npm scripts;
- JSDoc for public types and non-obvious safety behavior;
- dependency-injected SDK clients so tests never call AWS;
- typed command parsing and runtime validation;
- separate read-only inspection and destructive execution paths; and
- exclusion from the root CDK TypeScript build and focused CDK test command.

PR 3 creates only the read-only inspector. PR 4 adds destructive execution,
waiters, recovery, and absence verification. If the automation later moves to a
dedicated building-block repository, re-evaluate TypeScript versus Python or
Rust based on that repository's boundary rather than mechanically preserving
the original choice.

### 7.7 Future account separation

The first implementation must avoid embedding the current account ID or ECR URI
in source. CDK receives the standard account and Region target; fake targets are
used in tests and offline synth.

Future dev, staging, and production accounts should be able to deploy the same
stack with the same repository and output names. Each account then admits the
same candidate digest independently. No current abstraction should require a
single shared registry, cross-account pull policy, or replication before that
need is proven.

## 8. Alternatives Considered

### 8.1 Put ECR in `GoldenPathDemoStack`

Rejected. It makes routine cost-saving teardown either delete admitted artifacts
or retain an orphaned repository on every demo teardown. It also further grows a
stack already marked for future decomposition.

### 8.2 Create and manage ECR manually

Rejected. Manual creation is initially short but leaves mutability, lifecycle,
encryption, tags, outputs, drift, and cleanup undocumented and untested.

### 8.3 One CDK entrypoint with a mode/context switch

Rejected. It would make unrelated required inputs conditional and obscure which
lifecycle is being operated. Separate entrypoints express single responsibility
more clearly.

### 8.4 Direct CloudFormation export or SSM discovery

Rejected for now. Both introduce runtime coupling between the persistent
foundation and disposable workload. Explicit resolution by the release tooling
is easier to audit and carries cleanly into separate accounts.

### 8.5 GitHub OIDC admission in issue #12

Deferred. OIDC is the preferred future automation direction, but it requires a
reviewed trust policy, environment controls, least-privilege roles, and private
release orchestration. Local MFA-backed SSO is the approved bootstrap path.

### 8.6 Mutable convenience tags

Rejected. Tags such as `latest` or mutable environment aliases obscure machine
truth and can change without a reviewed deployment. Human lookup comes from
release evidence instead.

### 8.7 Customer-managed KMS key

Deferred. It adds key policy, lifecycle, failure modes, and cost without a
current lab requirement. Repository encryption cannot be changed in place, so
production must create a new repository and migrate artifacts deliberately.

### 8.8 Automatic deletion of tagged images

Rejected for the initial lab. ECR lifecycle policies do not know which digest is
deployed, evidenced, or needed for rollback. Only old untagged artifacts have a
safe automatic expiry rule today.

### 8.9 Central or replicated cross-account registry

Deferred. Account-local repositories are simpler and align with future account
isolation. Centralization should follow concrete scale, governance, latency, or
cost evidence.

## 9. Interfaces And Contracts

### 9.1 Foundation deployment interface

- Account and Region come from the standard CDK environment.
- The foundation requires no application image reference, service version, or
  ingress context.
- Dedicated scripts distinguish foundation synth/deploy from workload commands.
- Stack termination protection must be enabled by the documented deployment
  command and verified after deploy.

### 9.2 Workload interface

The existing workload input remains:

```text
<account-id>.dkr.ecr.<region>.amazonaws.com/movie-reservation-service@sha256:<64-hex-digest>
```

The account and Region must match the workload deployment target. A human
service version remains a separate input. Issue #12 must not weaken either
runtime validation.

### 9.3 Cleanup command interface

The exact CLI syntax is finalized in PR 3, but its semantics are fixed:

- inspection is the default and read-only;
- target input reuses the private, mode-`600` AWS target file accepted by the
  account preflight;
- execution requires a separate flag and exact confirmation;
- errors name the failed safety gate and do not continue to later mutations;
- machine-readable output is optional only if it does not expose raw account
  details into committed state.

## 10. State, Persistence, And Recovery

- CloudFormation owns the repository configuration while the foundation stack
  exists.
- The repository and its images survive foundation stack deletion because both
  deletion and replacement policies retain the resource.
- The final-cleanup tool explicitly deletes the retained repository after a
  successful stack deletion.
- A local, gitignored journal records live acceptance commands, approvals,
  sanitized results, failures, and recovery actions.
- A partially completed cleanup is recoverable: the tool can inspect either a
  protected stack plus repository or an already deleted stack plus retained
  repository.
- The workflow never treats absence of the foundation stack as permission to
  delete any repository with a similar name; the expected exact repository and
  target must still be validated.

## 11. Security And Privacy

- No secrets, tokens, credentials, SSO URLs, account IDs, real role identifiers,
  or raw target outputs enter Git.
- Examples use `111111111111`, fake role names, and fake digests.
- Service operations use SDK v3 with the exact profile/Region established by
  preflight; ambiguous ambient credentials are rejected.
- The cleanup inspector is read-only and lands before any destructive logic.
- Destructive cleanup verifies target identity, workload absence, exact resource
  identity, explicit execution intent, and explicit confirmation.
- Repository policies are not added. IAM identity policies and the ECS execution
  role provide the required access.
- Public documentation describes the generic contract; the private environments
  repository holds release selections and sanitized evidence, never secrets.

## 12. Performance, Scalability, Reliability, And Cost

- ECR storage and data transfer are the relevant ongoing repository costs;
  routine workload teardown does not remove them.
- The seven-day untagged rule bounds storage from interrupted or abandoned
  admissions while preserving tagged artifacts.
- Retaining every tagged image is acceptable for the initial lab volume. It is
  not the final multi-service production policy.
- Account-local repositories avoid cross-account pull dependencies and failure
  modes.
- Separate stacks reduce deployment blast radius and let the cheap foundation
  remain while ECS, ALB, Grafana, AMP, and other demo resources are destroyed.
- AWS Organizations, IAM Identity Center, and `CDKToolkit` are preserved; their
  lifecycle is not coupled to application artifacts.

## 13. Five-PR Implementation Sequence

Each PR starts from the merged predecessor. Do not combine slices merely because
the code is available locally.

### PR 1/5: Approved design and plan

Scope:

- Add this decision-complete plan.
- Add it to the plans index.
- Make no runtime, CDK, CI, dependency, or AWS changes.

Verification:

- Inspect the documentation diff.
- Check links, formatting, and placeholder-only examples.
- Confirm that the worktree contains no implementation changes.

### PR 2/5: Persistent ECR foundation

Scope:

- Add `bin/artifact-foundation.ts` and
  `lib/artifact-foundation-stack.ts`.
- Create the exactly configured `movie-reservation-service` repository.
- Add stable outputs and exact resource tags.
- Add dedicated foundation synth/CDK commands.
- Add `test/artifact-foundation.test.ts`.
- Add the offline foundation synth to CI while keeping automation, CDK
  assertions, tooling, and synth failures separately visible.

Verification:

- TypeScript build.
- Focused foundation assertions.
- Existing workload assertions, including zero ECR resources in the workload
  stack.
- Credential-free foundation synth with fake account/Region.
- Full local CI equivalent.
- No AWS calls.

### PR 3/5: Read-only cleanup inspector

Scope:

- Add an isolated TypeScript cleanup automation package.
- Use SDK v3 CloudFormation and ECR clients with exact SSO profile/Region input.
- Reuse the account-preflight target contract.
- Inventory the stack, protection state, repository, tags, lifecycle settings,
  and image digests.
- Detect whether `GoldenPathDemoStack` still exists.
- Print an explicit dry-run plan and perform no mutations.
- Add injected-client tests and a separate automation CI command/job.

Verification:

- Automation typecheck and focused unit tests.
- Tests prove that no mutation client method can be called by inspection.
- Missing, wrong-target, partially absent, and workload-present cases.
- Existing CDK and tooling suites remain separate.
- No AWS calls.

### PR 4/5: Guarded final cleanup

Scope:

- Add explicit execution mode and exact target-specific confirmation.
- Disable foundation stack termination protection.
- Delete and wait for the foundation stack while retaining ECR.
- Delete the exact retained ECR repository and images.
- Verify stack and repository absence.
- Support safe retry when the stack is absent but the retained repository
  remains.
- Preserve `CDKToolkit` and account-level resources by construction.

Verification:

- Wrong target, workload-present, missing confirmation, and dry-run cases make
  zero mutations.
- Expected SDK call ordering.
- Stack deletion failure prevents ECR deletion.
- Repository deletion failure is reportable and retryable.
- Waiter/timeout, already-absent, orphaned-repository, and final-verification
  cases.
- Full automation and repository CI.
- No AWS calls.

### PR 5/5: Operations and release integration

Scope:

- Add `docs/operations/aws-artifact-foundation.md` as the controlling runbook.
- Update the root README with separate foundation/workload commands.
- Update deployment and release-checklist prerequisites and handoffs.
- Update architecture documentation to distinguish persistent and disposable
  resources.
- Remove directly obsolete claims that ECR is manual/external, that only one
  stack exists, or that routine and full cleanup are the same operation.
- Document live acceptance, local journal use, recovery, production encryption
  migration, future scan choices, and future account separation.

Verification:

- Documentation link and command review.
- Placeholder/secret scan.
- Full local CI because documented commands now represent shipped behavior.
- No AWS calls.

## 14. Testing Strategy

### 14.1 Foundation CDK assertions

The focused foundation test must assert:

- exactly one `AWS::ECR::Repository`;
- repository name `movie-reservation-service`;
- immutable tags with no exclusions;
- AES-256/default ECR encryption;
- scan-on-push is not enabled;
- exactly the seven-day untagged lifecycle rule;
- `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain`;
- the five approved resource tags;
- the three stable outputs; and
- absence of IAM roles, IAM policies, OIDC providers, and unrelated resources.

Termination protection is deployment metadata rather than a repository template
property. Test the assembly/deployment command contract where practical and
verify it explicitly during the live rehearsal.

### 14.2 Workload regression tests

Existing tests must continue to prove:

- `GoldenPathDemoStack` creates no ECR repository;
- a full private ECR URI pinned by digest is required;
- image account and Region match the deployment target; and
- the ECS task execution role receives pull-only repository access.

### 14.3 Automation tests

- Keep cleanup automation out of `test/infra.test.ts` and the focused CDK suite.
- Use injected fake SDK clients; do not mock the network globally or require
  credentials.
- Test command parsing, runtime validation, target/preflight integration,
  dry-run output, state transitions, mutation ordering, failure stops, waiters,
  retries, and absence verification.
- Run automation before CDK tests in CI, consistent with the repository's
  existing layered verification model.

### 14.4 Offline synth

Add a foundation synth contract using fake account `111111111111` and
`eu-central-1`, with lookups disabled. It must not require an application image,
ingress prefix list, AWS login, or network access.

## 15. Rollout And Live Acceptance

After PR 5 merges, pause before AWS mutation and create a local gitignored
journal. Proceed one mutation group at a time with explicit approval:

1. Log in through the approved `movie-platform-demo` SSO profile and run the
   account preflight.
2. Synthesize the foundation and review the exact CloudFormation diff.
3. Explicitly deploy `ArtifactFoundationStack` with termination protection.
4. Verify its outputs, resource tags, encryption, immutability, lifecycle rule,
   retain policies, and protection state.
5. Attempt the documented ordinary deletion path and prove termination
   protection blocks it.
6. Run guarded final cleanup: inspect first, review the plan, then separately
   approve execution.
7. Verify that the foundation stack and repository are absent while
   `CDKToolkit`, Identity Center, Organizations, and operator access remain.
8. Redeploy the foundation through the approved command.
9. Verify that the repository is ready for the later private artifact-admission
   workflow.

No application image admission or workload deployment is required to accept
issue #12. Those actions remain later release slices.

Rollback before live deployment is a Git revert. After a foundation exists,
rollback must preserve the repository unless the operator explicitly chooses
the guarded final-cleanup path.

## 16. Risks And Mitigations

| Risk | Mitigation |
| --- | --- |
| Routine destroy deletes artifacts | Independent stack, retained resource, separate commands |
| Operator accidentally cleans the wrong account/Region | Existing exact-target preflight, SSO profile binding, explicit inventory and confirmation |
| Foundation stack is deleted but retained ECR deletion fails | Retry supports absent stack plus exact orphaned repository |
| Immutable tag blocks a repeated admission | Admission must use a new release tag or verify the existing digest; never overwrite |
| Tagged images grow without bound | Accept at lab scale; record future active/rollback-aware retention work |
| Shared lab repository blurs logical environments | Digest-pinned desired releases and evidence; one repository per future account |
| Admin permission is broader than needed | Local MFA-backed use only; later OIDC/least-privilege work remains explicit |
| AES-256 is insufficient for production controls | Production creates a new KMS-encrypted repository and migrates approved digests |
| Documentation exposes real account details | Fake placeholders in Git; local gitignored journal for real outputs |
| Cleanup code becomes mixed with CDK/business tests | Isolated automation package, configuration, scripts, and CI boundary |
| Stack termination protection is assumed but not enabled | Dedicated deploy command plus live post-deploy verification |

## 17. Done Criteria

- All five PRs are merged in order and remain independently reviewable.
- `ArtifactFoundationStack` independently synthesizes with no workload context.
- Its only application resource is the exactly configured
  `movie-reservation-service` ECR repository and its outputs.
- Routine workload teardown preserves the foundation and `CDKToolkit`.
- The repository retains on stack deletion and update replacement.
- The read-only inspector cannot mutate AWS.
- Guarded cleanup refuses wrong target, present workload, absent confirmation,
  and failed prerequisite states.
- Guarded cleanup safely handles both normal and partially completed deletion.
- CDK, automation, tooling, and synth checks remain separately attributable and
  credential-free in CI.
- Current docs clearly distinguish foundation deploy, workload deploy, routine
  teardown, and final cleanup.
- The post-merge live acceptance succeeds and is recorded only in a local,
  gitignored journal.
- The foundation is redeployed and ready for the environments-owned artifact
  admission work.

## 18. Review Checklist

- [x] Lifecycle ownership was reviewed and approved.
- [x] Routine and final teardown boundaries were reviewed and approved.
- [x] Repository mutability, encryption, scanning, and retention were reviewed
  and approved.
- [x] Public/private repository ownership was reviewed and approved.
- [x] Account/Region evolution was reviewed and approved.
- [x] TypeScript, SDK v3, test isolation, and documentation boundaries were
  reviewed and approved.
- [x] Five-PR delivery and post-merge live acceptance were reviewed and
  approved.
- [ ] PR 2 implementation matches this plan.
- [ ] PR 3 inspector makes no mutations.
- [ ] PR 4 cleanup safety cases pass.
- [ ] PR 5 establishes one controlling operations path.
- [ ] Live acceptance is explicitly approved and completed.

## 19. Handoff For The Next Slice

After PR 1 merges, create a new worktree from the updated `main` for PR 2/5.
Implement only the foundation entrypoint, stack, focused tests, offline synth,
and CI wiring described above. Do not add cleanup automation, broad documentation
rewrites, live AWS calls, or resources for the other services in PR 2.

## 20. References

Repository and local knowledge sources used during review:

- [`lib/application-image.ts`](../../lib/application-image.ts) and
  [`lib/config/platform-config.ts`](../../lib/config/platform-config.ts): current
  digest-pinned ECR consumption contract.
- [`test/infra.test.ts`](../../test/infra.test.ts): current workload ownership
  and CDK assertion contract.
- Local programming KB: `concepts/CDK Docker Image Assets.md`,
  `patterns/Multi-Service Release Composition.md`, and
  `concepts/AWS CDK Testing Layers.md`.
- Cross-repository parent plan:
  `docs/plans/reservation-only-aws-delivery-observability-smoke.md` in the lab
  parent repository.
- Private environment control model:
  `docs/architecture/environment-control-model.md` in
  `movie-platform-environments`.

Authoritative service references:

- [CloudFormation termination protection](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-protect-stacks.html)
- [CloudFormation `DeletionPolicy`](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-attribute-deletionpolicy.html)
- [AWS CDK ECR repository properties](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ecr.RepositoryProps.html)
- [ECR tag immutability](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-tag-mutability.html)
- [ECR encryption at rest](https://docs.aws.amazon.com/AmazonECR/latest/userguide/encryption-at-rest.html)
- [ECR image scanning](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-scanning.html)
- [ECR lifecycle policies](https://docs.aws.amazon.com/AmazonECR/latest/userguide/LifecyclePolicies.html)
- [ECR repository policies and IAM policies](https://docs.aws.amazon.com/AmazonECR/latest/userguide/repository-policies.html)
- [AWS SDK for JavaScript v3 credentials](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/getting-your-credentials.html)
