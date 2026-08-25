# Implementation Plan: Reservation Artifact Copy Mechanics

> Status: approved implementation unit; changes remain uncommitted until review
>
> Decision review completed in the private environments repository: 2026-08-24
>
> Current slice: public, credential-agnostic registry copy and verification only

## 1. Summary

Add a small TypeScript automation package that copies one already-approved
reservation-service image manifest from public GHCR to the persistent private
ECR repository without rebuilding or converting it. The package verifies the
source manifest before mutation and the destination manifest after mutation.

The first slice deliberately supports only a single OCI or Docker v2 image
manifest. It rejects OCI indexes and Docker manifest lists instead of selecting
a platform implicitly. A successful result proves exact equality of the
top-level manifest digest, config digest, and ordered layer digests.

This public repository owns the reusable artifact-transfer mechanics. The
private environments repository will later own candidate admission policy,
GitHub-to-AWS trust bindings, workflow orchestration, evidence retrieval,
admission records, and environment-manifest mutation.

## 2. Goals

- Copy a digest-pinned public GHCR image directly to a digest-pinned ECR
  destination with no Docker daemon and no application rebuild.
- Require the destination manifest to preserve the exact approved source
  digest.
- Verify the config digest and ordered layer digests before returning success.
- Reject image indexes, manifest lists, schema-1 images, caller-supplied tags,
  mutable source selectors, and malformed manifests.
- Keep credential values outside process arguments and outside the returned
  result.
- Provide credential-free unit and adapter-contract tests in the existing
  automation CI boundary.

## 3. Non-goals

- Retrieving or evaluating provenance, SBOM, or vulnerability evidence.
- Creating AWS IAM roles, GitHub OIDC providers, repository trust bindings, or
  live AWS configuration.
- Creating GitHub pull requests, admission records, deployment events, or
  environment-manifest changes.
- Defining retry/idempotency policy for the complete admission workflow.
- Selecting a child image from a multi-platform or attestation-bearing index.
- Copying signatures or referrers as a substitute for the separate evidence
  gate.
- Installing or pinning the runtime copy tool in a deployment workflow.

## 4. Approved Contract

### 4.1 Inputs

The copy operation receives:

- a fully qualified source registry reference pinned by `sha256` digest;
- a fully qualified destination repository;
- an expected source manifest digest equal to the source reference digest;
- an optional source registry auth-file path;
- a required destination registry auth-file path;
- a trusted, normalized absolute path to the workflow-pinned Skopeo executable;
  and
- an injected registry client implementation.

The copy destination is derived as
`<destination-repository>:sha256-<expected-digest-hex>`. This deterministic,
immutable tag keeps an admitted artifact outside the foundation's seven-day
untagged-image cleanup rule. It is a retention handle, not a deployment
selector. Destination verification and every workload reference use
`<destination-repository>@<expected-digest>`.

### 4.2 Verification sequence

1. Validate all references, digest values, auth-file paths, and the executable
   path before invoking an external process.
2. Read the source raw manifest by its immutable digest.
3. Hash the exact raw bytes and require the expected `sha256` digest.
4. Parse and validate a single OCI or Docker v2 image manifest.
5. Copy source to its deterministic destination retention tag with Skopeo
   `--preserve-digests`.
6. Read the destination raw manifest by the same immutable digest, never by the
   retention tag.
7. Hash and parse the destination manifest independently.
8. Require exact top-level digest, config digest, and ordered layer-digest
   equality.
9. Return a sanitized, immutable verification result.

The source is verified before the first mutation. Any command failure,
unsupported media type, malformed descriptor, digest mismatch, config
mismatch, or layer mismatch fails closed.

### 4.3 Runtime adapter

Use Skopeo as the proven registry-transfer engine. Invoke a caller-supplied,
absolute executable path directly without a shell and with HTTPS verification
enabled. The adapter uses:

- `skopeo inspect --raw` for byte-preserving manifest reads;
- `skopeo copy --preserve-digests` for registry-to-registry transfer;
- a digest-pinned `docker://` source, a derived immutable destination retention
  tag, and digest-pinned destination verification; and
- separate source/destination auth files rather than credentials in argv.

The core package owns no AWS SDK credential exchange. A later private workflow
will assume the approved admission role, create a short-lived destination auth
file, invoke this package, and delete the file.

## 5. Source Boundaries

```text
automation/artifact-copy/
  src/
    model.ts             typed input, port, and result contracts
    artifact-copy.ts     fail-closed orchestration
    image-manifest.ts    raw hashing, parsing, and equality checks
    skopeo-client.ts     no-shell process adapter
    artifact-copy-error.ts
    index.ts
  test/
    artifact-copy.test.ts
    image-manifest.test.ts
    skopeo-client.test.ts
  README.md
  tsconfig.json
  jest.config.cjs
```

`image-manifest.ts` contains pure domain validation. `artifact-copy.ts` depends
on a narrow `RegistryImageClient` port. `skopeo-client.ts` is the replaceable
process adapter. No environment-repository schema or GitHub API type crosses
this boundary.

## 6. Security And Failure Boundaries

- Accept only fully qualified registry names encoded as Docker references;
  reject URL schemes, whitespace, control characters, caller-supplied tags, and
  ambiguous short names. The adapter always requires TLS verification.
- Accept only lowercase `sha256:<64-hex>` digests.
- Pass credentials only through existing auth files. Never accept a password or
  token in the public API or command arguments.
- Require the trusted workflow to supply a normalized absolute executable path,
  then invoke fixed subcommands without a shell or `PATH` lookup.
- Bound process duration and captured output. Do not include command output or
  auth-file paths in normal errors.
- Require TLS verification for both registries.
- Do not emit source or destination credentials, registry responses, raw
  manifests, or local paths in the verification result.
- Treat copied-but-unverified destination content as failure. The later
  admission workflow must not record or deploy it.

## 7. Producer Compatibility Constraint

The current reservation-service workflow builds only `linux/amd64`, but
BuildKit's default registry provenance adds an attestation manifest and makes
the published candidate an OCI image index. That output is intentionally
incompatible with this first single-manifest admission slice.

Do not work around the mismatch by selecting the `linux/amd64` child: that
would change the approved candidate identity. Before live admission, make a
separate, explicitly approved service change that disables BuildKit's automatic
registry attestation while retaining the repository's existing explicit GitHub
provenance attestation. Multi-platform and content-graph equivalence remain a
later environments follow-up.

## 8. Tests

The package receives its own TypeScript and Jest configuration and runs in the
existing automation CI job, separately from CDK business-infrastructure tests.

Required tests cover:

- OCI and Docker v2 single-image manifests;
- OCI index, Docker list, schema-1, malformed JSON/UTF-8, malformed descriptor,
  and digest rejection;
- exact raw-byte hashing and ordered layer comparison;
- pre-copy source verification and post-copy destination verification;
- no copy invocation after invalid source input;
- sanitized failure behavior;
- exact no-shell Skopeo argument construction, absolute executable selection,
  derived retention tag, auth-file separation, timeout, and output limits; and
- successful immutable verification-result construction.

Validation commands:

```bash
npm run validate:artifact-copy
npm run ci
git diff --check
```

All tests remain credential-free and perform no registry or AWS mutation.

## 9. Delivery And Follow-ups

This implementation is one focused public-infra PR after user approval to
commit and publish it. It does not depend on private environment-repository
changes.

Subsequent reviewed units are:

1. parameterized AWS trust mechanics in public infra;
2. private repository/account trust bindings;
3. candidate evidence retrieval and verification;
4. private admission orchestration, idempotency, and content-addressed result;
5. bot-created admission-record PR; and
6. post-deployment observation and deployment-event recording.

Create the service producer-compatibility follow-up before attempting the first
live copy. Do not edit that sibling repository as part of this PR.
