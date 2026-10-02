# Audit contract vendor

> **Temporary workaround:** This tool exists only because the audit contract is
> not yet published as a versioned standalone artifact. It manually copies files
> between repositories and must be removed when consumers can depend on a
> released contract package or registry. The copied JSON Schema currently does
> not generate the Glue conversion schema, so reviewers must still check those
> definitions for compatibility.

This local developer tool copies one explicitly reviewed `platform-audit/1`
contract release from the producer repository (currently in movie reservation service) into the audit-ingestion package.
It records the producer Git commit and SHA-256 hash of every copied artifact so
normal builds and CI can verify the committed bundle without accessing another
repository.

The command does not discover or download the latest contract. Run it only when
intentionally preparing an infrastructure PR for a specific producer revision:

```bash
npm run vendor:audit-contract -- \
  /absolute/path/to/movie-reservation-service/packages/audit-sdk/contract \
  <40-character-reviewed-source-commit>
```

Review and commit the resulting changes under
`packages/audit-ingestion/contract/`. Ordinary build, test, synth and deploy
commands never run this mutation.

CI type-checks the tool and exercises it against temporary directories:

```bash
npm run validate:audit-contract-vendor
```
