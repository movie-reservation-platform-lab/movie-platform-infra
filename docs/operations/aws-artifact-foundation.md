# AWS Artifact Foundation Runbook

This is the controlling operations path for `ArtifactFoundationStack` and its
retained ECR repositories. Use it to deploy and verify the persistent artifact
foundation, understand its handoff to artifact admission, and perform separately
approved final cleanup.

This runbook does not authorize AWS changes. Every live mutation group still
requires explicit operator approval and a fresh account preflight. During the
issue #12 implementation PRs, run only the credential-free checks.

## Lifecycle Boundaries

The repository deliberately has two CDK applications with different lifecycles:

| Boundary | Entrypoint and command | Routine action |
| --- | --- | --- |
| Persistent artifact foundation | `bin/artifact-foundation.ts`; `npm run cdk:foundation -- ...` | Preserve between demos |
| Disposable demo workload | `bin/infra.ts`; `npm run cdk -- ...` | Destroy promptly after a demo |

`ArtifactFoundationStack` currently owns the account-local and Region-local
`movie-reservation-service` ECR repository. The repository retains tagged
admitted images, expires only untagged images older than seven days, and is
protected by both CloudFormation termination protection and retain policies.
It can still incur ordinary ECR storage and request charges while preserved.

`MovieReservationWorkloadStack` imports an explicitly selected ECR image by
digest. It does not own the application repository and routine workload teardown
must not remove admitted artifacts.

The following resources are outside both lifecycle commands:

- `CDKToolkit` and its deployment assets;
- the customer-managed ingress prefix list;
- AWS Organizations and IAM Identity Center;
- operator identity, MFA, permission sets, and account assignments; and
- root-account recovery controls.

Deleting any of those requires its own dependency review, procedure, and
explicit approval.

## Responsibility Handoff

This public infrastructure repository owns ECR destination names, repository
settings, stable CloudFormation outputs, retention/deletion safety, and generic
operator commands.

The private `movie-platform-environments` repository will own the later artifact
admission workflow: selecting an allowlisted GHCR candidate, verifying its
provenance and security evidence, copying that exact digest into the target ECR
repository, and recording the desired and admitted digests. Neither repository
may contain credentials or secrets.

The handoff is deliberately runtime-based:

```text
ArtifactFoundationStack outputs
  -> environments-owned artifact admission
  -> exact ECR repository URI plus admitted sha256 digest
  -> MovieReservationWorkloadStack deployment context
```

Do not add a CloudFormation cross-stack reference, committed account ID, or
committed concrete ECR URI. In future development, staging, and production
accounts, deploy the same foundation independently and admit the approved
candidate into each account-local repository.

## Prerequisites

Before any live foundation operation:

- all repository changes for the intended release are reviewed and merged;
- `npm run ci` passes without AWS credentials;
- the MFA-backed `movie-platform-demo` SSO profile and mode-`0600` private target
  file are configured as described in the
  [access bootstrap runbook](./standalone-account-access-bootstrap.md);
- the intended account and `eu-central-1` Region are explicit;
- `CDKToolkit` exists in that account and Region, or its separately reviewed
  bootstrap is approved; and
- the operator understands the expected ECR cost and the difference between
  routine workload teardown and final project cleanup.

Foundation deployment does not require an application image reference or the
workload ingress prefix list.

Use local shell values only; never commit real target identifiers:

```bash
export AWS_PROFILE=movie-platform-demo
export AWS_REGION=eu-central-1
export AWS_ACCOUNT_ID='<12-digit-account-id>'
export CDK_DEFAULT_ACCOUNT="$AWS_ACCOUNT_ID"
export CDK_DEFAULT_REGION="$AWS_REGION"
```

## Local Acceptance Journal

Before the post-merge live acceptance, create an operator-owned journal:

```bash
mkdir -p .local
touch .local/aws-artifact-foundation-acceptance.md
git check-ignore --quiet .local/aws-artifact-foundation-acceptance.md
```

Stop if `git check-ignore` fails. The repository ignores `.local/`, but the
journal must still contain only sanitized evidence:

- date/time and the approval checkpoint;
- reviewed Git commit;
- command name and intent, without credentials or expanded sensitive values;
- pass/fail outcome and redacted account last four;
- relevant warning or blocker codes; and
- failure, recovery, and follow-up decisions.

Do not paste complete account IDs, ECR URIs, ARNs, role names/suffixes, SSO URLs,
emails, tokens, credentials, raw target-file contents, or unredacted command
output. The journal remains local and must not be added with `git add -f`.

## Credential-Free Verification

Run this during PR review and again from the exact post-merge release checkout:

```bash
npm ci
npm run ci
```

The suite type-checks and tests the account preflight and cleanup automation
before the CDK and tooling suites. It also synthesizes the workload and
foundation contracts with fake targets and `--no-lookups`. Passing offline
tests proves the modeled contract, not successful AWS provisioning.

## Deploy The Persistent Foundation

This is a live AWS procedure. Start only after explicit approval for this
mutation group.

Start or refresh the dedicated SSO session and validate the pinned target:

```bash
aws sso login --profile "$AWS_PROFILE"
npm run preflight:aws
```

If `CDKToolkit` is not already deployed in the target account and Region,
bootstrap it as its own approved mutation group. Do not delete it during project
cleanup:

```bash
npm run preflight:aws
npm run cdk:foundation -- bootstrap "aws://$AWS_ACCOUNT_ID/$AWS_REGION"
```

Synthesize locally, then use the live target only for the CloudFormation diff:

```bash
npm run cdk:foundation -- synth ArtifactFoundationStack --no-lookups
npm run cdk:foundation -- diff ArtifactFoundationStack
```

Review the stack name and confirm that the change contains the configured ECR
repositories and outputs only. The foundation must not contain the workload,
IAM identities, GitHub federation, or application source builds.

Deploy is a new mutation group. Obtain approval and rerun preflight immediately
before it:

```bash
npm run preflight:aws
npm run cdk:foundation -- deploy ArtifactFoundationStack
```

The CDK stack declaration enables termination protection. Do not manually
disable it during routine operation.

## Verify The Foundation

Run the repository-owned read-only inspector:

```bash
npm run cleanup:artifact-foundation
```

For a normal newly deployed foundation with no workload stack, expect `READY`
with no blockers. Review its redacted target and confirm:

- stack name `ArtifactFoundationStack`, successful status, and termination
  protection enabled;
- repository name `movie-reservation-service` and registry account match;
- immutable tags with no mutability exclusions;
- AES-256 ECR encryption;
- manual rather than scan-on-push scanning for the current lab model;
- the seven-day expiration rule applies only to untagged images;
- the exact `Platform`, `Service`, `Scope`, `Lifecycle`, and `ManagedBy` tags;
- the three repository name, URI, and ARN outputs agree with the inspected
  repository; and
- the inventory contains only the images actually present.

The focused CDK assertions and synthesized template verify both
`DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain`; those policies are
CloudFormation template behavior rather than mutable ECR settings.

### Termination-protection acceptance check

Issue #12 live acceptance includes one intentional attempt to use the ordinary
CDK deletion path. This is a destructive request expected to fail, not an
offline test. Run it only with separate explicit approval, after recording the
checkpoint in the local journal:

```bash
npm run preflight:aws
npm run cdk:foundation -- destroy ArtifactFoundationStack
```

The expected outcome is rejection because termination protection is enabled.
If the stack deletion starts instead, stop: do not delete the retained ECR
repository. Record the failure, inspect current state, and use a focused
corrective PR before continuing.

## Artifact Admission And Workload Handoff

Issue #12 stops after the empty foundation is accepted and redeployed. It does
not copy a GHCR image or deploy the workload.

In the later environments-owned release workflow:

1. Resolve the foundation outputs for the validated target at runtime.
2. Verify the approved immutable GHCR candidate and its evidence.
3. Copy that exact artifact into the account-local ECR destination.
4. Record the source and admitted digests in sanitized release evidence.
5. Pass `<repository-uri>@sha256:<admitted-digest>` plus a human release ID to
   the [workload deployment runbook](./aws-cdk-deployment.md).
6. Verify the requested digest against the running ECS task in the later
   environments acceptance workflow.

Do not rebuild application source in this repository or treat a mutable tag as
a deployable selector.

## Routine Demo Teardown

Routine teardown destroys only `MovieReservationWorkloadStack` using the
[workload deployment runbook](./aws-cdk-deployment.md#teardown). It must
preserve:

- `ArtifactFoundationStack` and every admitted image;
- `CDKToolkit`;
- the ingress prefix list; and
- account-level identity and governance.

Use final cleanup only when retiring the project foundation or when the issue
#12 live-acceptance sequence explicitly calls for cleanup followed by redeploy.

## Guarded Final Cleanup

Final cleanup permanently deletes the foundation repository and every image in
it. It is intentionally a different CLI operation from workload teardown.

First ensure the disposable workload stack is gone. Then run the read-only
inspection:

```bash
npm run cleanup:artifact-foundation
```

Interpret the result:

- `BLOCKED`: resolve every reported blocker; do not execute cleanup.
- `READY`: review the target, stack, repositories, images, warnings, planned
  scope, and printed confirmation phrase.
- `NOTHING_TO_CLEAN`: the stack and all configured repositories are absent; no
  execution is required.

The command prints the exact phrase only for a ready target. Do not invent it or
literally use `<last-four>`. After separate approval for destructive execution,
copy the printed phrase into:

```bash
npm run cleanup:artifact-foundation -- \
  --execute \
  --confirm "<exact phrase printed by the preceding READY inspection>"
```

The execution invocation reruns preflight and live inspection, requires the
exact target-specific phrase and zero blockers, re-verifies the mutation caller,
disables foundation termination protection, deletes and waits for the stack,
force-deletes only the catalogued retained repositories, and finally requires a
fresh inspection to prove absence.

After success, rerun the read-only command and require `NOTHING_TO_CLEAN`:

```bash
npm run cleanup:artifact-foundation
```

`CDKToolkit`, the ingress prefix list, Organizations, Identity Center, operator
access, and root controls remain outside the cleanup adapter.

## Recovery And Retry

Always rerun the read-only inspector after a failure or interrupted session.
Do not infer current AWS state from the last command attempted.

| Inspected state | Meaning and action |
| --- | --- |
| Foundation stack and expected repository exist | Normal state. Resolve blockers, review warnings, and use the ordinary guarded flow. |
| Foundation stack is absent but the exact retained repository exists | Approved resumable state. Review the `RETAINED_REPOSITORY_WITHOUT_STACK` warning, obtain fresh approval, and rerun guarded execution; only the retained repository remains to delete. |
| Foundation stack exists but an expected repository is absent | Inconsistent and blocked. Do not create or delete a similarly named repository manually; investigate drift and use a corrective PR or reviewed recovery plan. |
| Stack or repository operation is still in progress | Wait for a terminal AWS state, then inspect again. Never bypass the blocker. |
| Both stack and configured repositories are absent | `NOTHING_TO_CLEAN`; stop successfully. |

If stack deletion or its waiter fails, cleanup stops before repository deletion.
If repository deletion fails after the stack is absent, inspection makes that
partial state visible and execution can be retried. A repository-not-found
response is treated as already completed. Success is reported only after final
absence verification passes.

## Issue #12 Live-Acceptance Sequence

After PR 5 merges, obtain approval one mutation group at a time and record only
sanitized outcomes in the local journal:

1. Run offline CI from the exact merged checkout.
2. Log in and pass account preflight.
3. Synthesize and review the foundation diff.
4. Deploy `ArtifactFoundationStack`.
5. Verify outputs, configuration, tags, retention, and termination protection.
6. Separately approve and prove the ordinary destroy path is blocked.
7. Run read-only cleanup inspection.
8. Separately approve and execute guarded final cleanup.
9. Require `NOTHING_TO_CLEAN` while verifying account foundations remain.
10. Separately approve and redeploy `ArtifactFoundationStack`.
11. Verify the empty repository is ready for the later artifact-admission flow.

No application image admission or workload deployment is required for issue
#12 acceptance.

## Future Production Decisions

The current lab deliberately uses no-extra-key-cost AES-256 ECR encryption,
manual ECR basic scanning, immutable tags, and expiration of only untagged images
older than seven days. Do not promote those choices silently into production.

Before production:

- choose the required KMS key ownership, rotation, access, and recovery model;
- create a new repository with that encryption choice and re-admit approved
  digests, because ECR repository encryption cannot be changed in place;
- choose registry-level basic scan-on-push or Amazon Inspector enhanced
  scanning, define which evidence blocks admission, and avoid duplicating the
  existing Trivy gate without a clear owner;
- define active, rollback, legal, and cost-aware tagged-image retention; and
- deploy the same foundation independently in development, staging, and
  production accounts unless a reviewed replication or central-registry design
  proves preferable.

Current AWS references:

- [Amazon ECR encryption at rest](https://docs.aws.amazon.com/AmazonECR/latest/userguide/encryption-at-rest.html)
- [Amazon ECR scanning filters](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-scanning-filters.html)
