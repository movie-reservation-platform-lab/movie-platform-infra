# Implementation Plan: Idempotent Artifact Verification Mode

## 1. Summary

Add a backward-compatible v2 request/result contract to the public artifact
copy CLI. V2 requires an explicit `copy-and-verify` or `verify-existing`
operation. The latter verifies exact source and destination manifest, config,
and ordered-layer identity without invoking the mutating registry port.

## 2. Goals

- Preserve v1 request parsing, copy behavior, output, and failure codes.
- Add a closed v2 request with an explicit operation.
- Emit a closed v2 result with `copied` or `already-present` outcome.
- Reuse the existing validation and content-equivalence implementation.
- Keep verification-only credential-agnostic and mutation-free.
- Provide a source-only compiled runtime that private automation can build
  before assuming AWS credentials.

## 3. Non-goals

- Querying ECR existence or choosing the operation for private admission.
- Defining private account, repository, workflow, or IAM policy.
- Copying indexes, lists, signatures, or referrers.
- Deploying or contacting AWS or either registry.

## 4. Current State

`copyAndVerifyArtifact` validates and reads the source, always invokes
`RegistryImageClient.copy`, then reads and compares the destination. The v1 CLI
request and `exact-manifest-digest-v1` output are closed. That path is correct
for a first copy but cannot represent an immutable-destination exact retry.

## 5. Requirements and Assumptions

### Confirmed Requirements

- `artifact-copy-request-v1` remains byte-contract compatible.
- V2 accepts exactly the v1 identity/auth fields plus `operation`.
- `verify-existing` never invokes `RegistryImageClient.copy`.
- Both modes validate the source before any possible mutation and independently
  validate destination bytes.
- A v2 success states the exact selected outcome without registry diagnostics,
  paths, credentials, repository names, or account identifiers.

### Assumptions

- Private orchestration checks deterministic ECR tag/digest state and chooses
  the v2 operation from trusted policy.
- Destination absence in verification-only mode is classified as destination
  verification failure.

### Open Questions

None.

## 6. Proposed Design

Define:

```ts
type ArtifactTransferOperation = 'copy-and-verify' | 'verify-existing';
type ArtifactTransferOutcome = 'copied' | 'already-present';
```

Keep the existing v1 model and `copyAndVerifyArtifact` export unchanged. Add a
v2 orchestrator that shares internal source/destination inspection helpers:

1. Validate the exact request.
2. Read and validate the digest-pinned source.
3. For `copy-and-verify`, invoke the existing deterministic retention-tag copy.
4. For `verify-existing`, skip the copy port completely.
5. Read destination only by expected digest.
6. Require manifest/config/ordered-layer equality.
7. Emit `exact-manifest-digest-v2` plus the operation-derived outcome.

The transport parser returns a discriminated union:

```json
{
  "requestVersion": "artifact-copy-request-v2",
  "operation": "verify-existing",
  "sourceReference": "ghcr.io/...@sha256:...",
  "destinationRepository": "registry/repository",
  "expectedDigest": "sha256:...",
  "destinationAuthFile": "/absolute/private/auth.json"
}
```

V1 rejects `operation`; v2 requires it. Unknown versions, operations, fields,
duplicates, inline credentials, and executable selection still fail closed.

## 7. Alternatives Considered

### Retry the existing copy and reinterpret the error

Rejected. Registry/process error text is not a stable idempotency contract and
could hide a conflict or partially copied destination.

### Duplicate destination verification privately

Rejected. Public infra owns registry-copy and content-equivalence mechanics;
duplicating them in the environments repository creates divergent trust code.

### Add an unversioned optional flag

Rejected. It weakens the existing closed transport and makes output semantics
ambiguous. V2 preserves v1 exactly.

## 8. API / Interface Changes

- Add `ARTIFACT_COPY_CLI_REQUEST_VERSION_V2`.
- Add a discriminated v1/v2 parsed-request union.
- Add a v2 transfer function and `exact-manifest-digest-v2` result.
- V2 result adds only `outcome: copied|already-present` to the existing
  content-identity fields.
- Existing v1 exports and output remain unchanged.

## 9. Data Model / Persistence Changes

None.

## 10. Security, Privacy, and Abuse Considerations

- Operation is closed and versioned; it cannot choose an executable or target.
- Verification-only has strictly less authority than copy and cannot invoke the
  mutating port even if destination verification fails.
- Auth paths remain normalized absolute file references and never appear in
  output/errors.
- Trusted private orchestration still owns destination allowlisting and IAM.
- The privileged registry job runs only the credential-free job's compiled
  runtime; it does not install npm dependencies or execute `ts-node` while AWS
  credentials are present.

## 11. Performance, Scalability, and Reliability Considerations

Verification-only performs two bounded manifest reads and no layer transfer.
All failures remain fail-closed. Private admission may retry transient reads by
starting a new workflow; the public CLI adds no hidden retries.

## 12. Implementation Steps

1. Add v2 operation/outcome models while preserving v1 types.
2. Factor shared source/destination verification and add the mutation-free v2
   branch.
3. Parse the exact discriminated v1/v2 transports and dispatch in the CLI.
4. Add and smoke-test a source-only CommonJS runtime build.
5. Update package README/help and focused tests.
6. Run artifact-copy validation and full repository CI.

## 13. Testing Strategy

- Existing v1 tests remain unchanged and passing.
- V2 parser accepts both exact operations and rejects missing/unknown fields.
- `verify-existing` records two reads and zero copy calls.
- `copy-and-verify` preserves source-read, copy, destination-read ordering.
- Destination absence/drift maps to destination-verification failure.
- V2 stdout contains only method, outcome, and content digests.
- The compiled runtime excludes tests, npm metadata, and `node_modules`, and its
  help path runs without `ts-node`.
- Full credential-free CI and offline synths pass.

## 14. Rollout / Migration Plan

Private environments pins the merged infra revision and uses v2. Existing v1
callers need no migration. Rollback is a revert PR; no live state is changed by
this implementation.

## 15. Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| v1 behavior accidentally changes | Retain v1 types/function/output and run existing tests |
| Verification-only invokes copy | Exact event/call-count regressions |
| Outcome overstates ECR state | Emit only after full destination equivalence succeeds |
| Private caller selects wrong mode | Private ECR state policy remains a separate reviewed boundary |

## 16. Done Criteria

- V1 is unchanged and fully covered.
- V2 exact copy and no-op verification paths pass focused tests.
- Help/README document caller-owned mode selection.
- `npm run validate:artifact-copy`, `npm run ci`, and `git diff --check` pass.
- No AWS, registry, GitHub trust, or deployment mutation occurs.

## 17. Review Checklist

- [x] Requirements and non-goals are explicit.
- [x] Alternatives and security boundaries are recorded.
- [x] Compatibility and rollback are defined.
- [x] Tests and verification are concrete.

## 18. Handoff Prompt for Implementation Agent

Implement this plan for issue #35. Preserve v1 exactly, keep v2 closed and
credential-agnostic, prove verification-only never calls copy, update focused
docs/tests, and perform no live registry or AWS action.
