# Artifact Foundation Cleanup Readiness

This command answers one operator question: can final project cleanup safely
move on to deleting the persistent artifact foundation?

In PR 3/5 the answer is only a dry-run report. The command cannot delete or
change AWS resources. It checks the pinned AWS target, verifies that the
disposable workload stack is gone, inventories the foundation stack and
configured retained ECR destinations, and prints one of three outcomes:

- `BLOCKED`: cleanup must not proceed, for example because `MovieReservationWorkloadStack`
  still exists or the foundation stack outputs and a configured repository do
  not agree.
- `READY`: no blocking condition was found for the current final-cleanup target.
- `NOTHING_TO_CLEAN`: `ArtifactFoundationStack` and all configured artifact
  destination repositories are already absent.

The cleanup target is `ArtifactFoundationStack` plus the retained ECR
repositories listed in
[`../../lib/artifact-foundation-repositories.ts`](../../lib/artifact-foundation-repositories.ts).
The current catalog has one destination:
`reservation-service -> movie-reservation-service`. Routine demo teardown is
different: it destroys only `MovieReservationWorkloadStack` and must preserve the
artifact foundation.

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

`READY` is a human summary, not an execution API. PR 4/5 must make destructive
decisions from the current inspected resources and typed issue codes, not by
parsing report prose. Configuration-drift warnings remain visible but advisory
for this lab cleanup model.

This slice imports only AWS read commands. There is no `--execute` option and no
AWS mutation path. PR 4/5 will add separately guarded execution after another
review.

Run the credential-free package checks with:

```bash
npm run validate:artifact-foundation-inspector
```

Print help without reading the private target or contacting AWS:

```bash
npm run inspect:artifact-foundation -- --help
```

The live inspection command is deliberately not part of CI:

```bash
npm run inspect:artifact-foundation
```

It uses the same private mode-`0600` target file as
`automation/aws-account-preflight`. Real account identifiers and results must
remain outside Git.
