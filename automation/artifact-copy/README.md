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

This package does not provide a live CLI or obtain credentials. The private
release-control workflow will later supply short-lived registry auth files and
consume the sanitized verification result. It must also supply the normalized
absolute path of the workflow-pinned Skopeo executable; the adapter never
selects a credential-bearing executable through `PATH`.

Run its credential-free checks from the repository root:

```bash
npm run validate:artifact-copy
```
