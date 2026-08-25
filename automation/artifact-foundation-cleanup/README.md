# Artifact Foundation Cleanup

This command answers one operator question: can final project cleanup safely
remove the persistent artifact foundation? Inspection remains the default and
cannot change AWS. Destructive execution is a separately guarded mode.

The controlling operator sequence, lifecycle boundaries, live acceptance, and
recovery procedure live in the
[AWS artifact-foundation runbook](../../docs/operations/aws-artifact-foundation.md).

The command checks the pinned AWS target, verifies that the disposable workload
stack is gone, inventories the foundation stack and configured retained ECR
destinations, and prints one of three outcomes:

- `BLOCKED`: cleanup must not proceed, for example because `MovieReservationWorkloadStack`
  still exists or the foundation stack outputs and a configured repository do
  not agree.
- `READY`: no blocking condition was found for the current final-cleanup target.
- `NOTHING_TO_CLEAN`: `ArtifactFoundationStack` and all configured artifact
  destination repositories are already absent.

The cleanup target is `ArtifactFoundationStack` plus the retained ECR
repositories listed in
[`../../lib/artifact-foundation-repositories.ts`](../../lib/artifact-foundation-repositories.ts).
The current catalog has six destinations, one for each integrated demo
application image. Routine demo teardown is different: it destroys only
`MovieReservationWorkloadStack` and must preserve the artifact foundation.

Onboarding another service is an explicit catalog and infrastructure change,
not automatic sibling-repository discovery. The component IDs should match the
`ComponentCatalog` contract in `movie-platform-environments`, while this infra
catalog owns only AWS artifact destinations that `ArtifactFoundationStack`
actually provisions. Keeping that adapter isolated makes it replaceable later
with a reader backed by `movie-platform-environments` or a dedicated catalog
repository.

The command performs these read-only checks:

- runs the existing account preflight and receives its validated profile,
  account, Region, permission set, and shared AWS config-file paths;
- builds AWS SDK for JavaScript v3 clients from that exact preflight result
  rather than the ambient default credential chain;
- rechecks the SDK caller with STS before reading resource state;
- reads `MovieReservationWorkloadStack`, `ArtifactFoundationStack`, and every configured
  artifact destination repository;
- reports repository settings, ownership tags, lifecycle policy, and image
  digests; and
- emits stable issue codes for future guarded cleanup logic.

The stable readiness values and issue-code catalog live in
[`src/model.ts`](src/model.ts); policy code should reference that catalog rather
than repeating serialized code strings.

`READY` is a human summary, not an execution API. Execution recomputes safety
from current inspected resources and typed issue codes; it never parses report
prose or trusts `READY` by itself. Configuration-drift warnings remain visible
but advisory for this lab cleanup model.

Run the credential-free package checks with:

```bash
npm run validate:artifact-foundation-cleanup
```

Print help without reading the private target or contacting AWS:

```bash
npm run cleanup:artifact-foundation -- --help
```

The live inspection command is deliberately not part of CI:

```bash
npm run cleanup:artifact-foundation
```

Run inspection first and review the exact target, blockers, warnings, resources,
images, and printed confirmation phrase. Destructive execution then requires
both flags in the same invocation:

```bash
npm run cleanup:artifact-foundation -- \
  --execute \
  --confirm "<exact phrase printed by the preceding READY inspection>"
```

Do not invent the phrase or literally type `<last-four>`; copy the complete
target-specific phrase printed by the read-only command.

Execution performs these operations in fail-closed order:

1. Re-runs preflight and the read-only inspection.
2. Requires zero blockers and the exact target-specific confirmation.
3. Re-verifies the mutation SDK caller.
4. Disables foundation termination protection when currently enabled.
5. Deletes the foundation stack and waits for confirmed absence.
6. Force-deletes each exact retained ECR repository and all its images.
7. Re-inspects and requires the stack and configured repositories to be absent.

A stack request or waiter failure stops before ECR deletion. If stack deletion
succeeds but repository deletion fails, rerun inspection: the absent stack plus
exact retained repository is an approved resumable state. Repository-not-found
responses are treated as already completed.

`MovieReservationWorkloadStack`, `CDKToolkit`, the ingress prefix list, and
account-level Organizations and IAM Identity Center resources are outside the
mutation adapter by construction.

It uses the same private mode-`0600` target file as
`automation/aws-account-preflight`. Real account identifiers and results must
remain outside Git.
