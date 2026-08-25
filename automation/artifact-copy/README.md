# Artifact Copy Automation

Credential-agnostic mechanics for copying one already-approved, digest-pinned
single-image manifest from a source registry to a destination registry without
rebuilding it.

The package validates source bytes before mutation, invokes Skopeo with digest
preservation enabled, and independently verifies the destination manifest,
config, and ordered layer digests. It rejects OCI indexes and Docker manifest
lists; this first slice never selects a platform implicitly. The copy receives
a deterministic immutable `sha256-<digest>` tag so the artifact is not removed
by the foundation's untagged-image lifecycle rule. Deployment identity remains
the independently verified digest, never the tag.

The package exposes these mechanics through a small CLI. It does not obtain
credentials or evaluate candidate policy. The private release-control workflow
supplies short-lived registry auth files and consumes the sanitized verification
result. It also supplies the normalized absolute path of the workflow-pinned
Skopeo executable; the adapter never selects an executable through `PATH`.

## CLI contract

Private admission checks out a pinned revision of this repository, installs its
locked npm dependencies, installs or selects its pinned Skopeo version, and
writes one request file. It selects the trusted Skopeo installation separately
from that untrusted document. Invoke the command with the request file and the
workflow-resolved executable path:

```bash
npm run copy:artifact -- \
  --request-file /runner/temp/artifact-copy-request.json \
  --skopeo-executable /opt/pinned-skopeo/bin/skopeo
```

The request is bounded to 64 KiB, must be UTF-8, and must contain exactly this
versioned JSON shape. Duplicate keys, unknown fields, missing fields, inline
credentials, and unsupported field values are rejected.

```json
{
  "requestVersion": "artifact-copy-request-v1",
  "sourceReference": "ghcr.io/movie-reservation-platform-lab/movie-reservation-service@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "destinationRepository": "111111111111.dkr.ecr.eu-central-1.amazonaws.com/movie-reservation-service",
  "expectedDigest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "destinationAuthFile": "/runner/temp/ecr-auth.json"
}
```

`skopeoExecutablePath` is deliberately not a request field and is rejected as
unknown if present. Otherwise, a modified admission request could select an
attacker-controlled local binary before the no-shell adapter runs. Private #17
must pin and install the approved Skopeo version, resolve its normalized absolute
path from trusted workflow configuration, and pass that path through
`--skopeo-executable`. The public CLI does not hardcode private runner paths.

`sourceAuthFile` is the only optional field. When it is absent, GHCR access is
anonymous. When present, it must be a normalized absolute path like the required
`destinationAuthFile`. Tokens and passwords are never request fields or command
arguments; the caller creates the auth files with restrictive permissions and
deletes the request and auth files after the command completes.

The caller, not this credential-agnostic CLI, owns destination policy. Private
admission must construct `destinationRepository` from its committed trusted
binding. Supplying an untrusted destination together with a self-declared
allowlist in the same request would add no security, so this contract has no
allowlist field. The artifact-copy library validates the complete repository
syntax and exact content identity, and the admission role's repository-scoped
IAM permissions are the AWS enforcement backstop.

Successful stdout contains only the existing `ArtifactCopyVerification` JSON:

```json
{
  "verificationMethod": "exact-manifest-digest-v1",
  "sourceManifestDigest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "destinationManifestDigest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "configDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "layerDigests": [
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  ]
}
```

Failures write one stable classification to stderr without forwarding registry,
process, manifest, credential-path, or unexpected exception details:

| Exit | Classification | Boundary |
| ---: | --- | --- |
| `1` | `INTERNAL_ERROR` | Unexpected adapter defect; fail closed. |
| `2` | `INVALID_INPUT` | CLI arguments, request transport, request semantics, or executable selection. |
| `3` | `SOURCE_REJECTED` | Source read, digest, media type, or manifest validation. |
| `4` | `COPY_FAILED` | Registry mutation failed before destination verification. |
| `5` | `DESTINATION_VERIFICATION_FAILED` | Destination read, digest, manifest, config, or ordered-layer verification. |

An exit of `4` or `5` can mean destination content exists but was not verified.
Private admission must never record or deploy it as admitted.

Run its credential-free checks from the repository root:

```bash
npm run validate:artifact-copy
```

The validation runs TypeScript checks, credential-free Jest tests, and the CLI
help path. It does not read auth files, contact a registry, or mutate AWS.
