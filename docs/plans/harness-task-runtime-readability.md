# Harness task runtime readability refactor

Status: done

## Goal and authorization

Continue the engineer's requested readability refactoring of `task-runtime.ts`:
document contracts, split cohesive responsibilities, and name complex operations.
Preserve the existing behavior and public import paths. This is local refactoring;
no live AWS action is authorized or required.

## Evidence and design

The current 537-line module combines dispatch, an AWS adapter factory, watcher
startup/candidate polling, and release adapter construction. CLI and tests import
`runTask`, `gateExitCode`, and runtime types from it.

Extract `task-aws.ts`, `watch-task.ts`, `release-task.ts`, and `runtime-types.ts`.
Keep dispatch and compatibility type re-exports in `task-runtime.ts`. Extract named
probe and registration/update operations where they clarify the workflow.
Keep functions used by the reader first and supporting functions/types below.

Alternative: only add comments/extract local helpers. Rejected because the module
would still have several independent reasons to change. No new packages, framework,
runtime validation rules, AWS operations, or generalized DI machinery are needed.

## Compatibility and risks

Preserve call ordering, payloads, task/image identity checks, bootstrap alarm rules,
metric-before-state publication, deadlines, terminal results and error messages.
Keep the shared pure release/watch policy modules unchanged. Avoid runtime import
cycles by placing shared types in `runtime-types.ts` and using type-only imports.
Keep existing hand-written AWS response parsing for this behavior-preserving split;
a schema migration would change validation and is separate scope.

## Acceptance and verification

The ongoing session establishes preservation of current behavior as the refactoring
contract. Existing synthetic tests characterize these acceptance scenarios:

| ID | Behavior | Evidence |
|---|---|---|
| AC-01 | Gate exit codes and invalid artifact/alarm observations | task-runtime.test.ts |
| AC-02 | Bootstrap exception, actual alarm checks and update configuration | bootstrap.test.ts |
| AC-03 | Readiness remains stable during metric/alarm publication | watch-readiness.test.ts |
| AC-04 | Existing CLI and decision consumers remain compatible | full workspace tests/typecheck/build |

Commands from repository root: workspace `npm test`, `npm run typecheck`, and
`npm run build` for `@movie-platform/harness-buy-check`; touched-file ESLint and
Prettier; `git diff --check`. Baseline: all 54 tests pass before production edits.
Additional tests should cover meaningful untested paths exposed by the split.

## Steps

1. Record passing baseline (complete).
2. Extract modules and document contracts (balanced implementation; no delegation).
3. Extract named watcher/release operations and verify behavior (balanced).
4. Run workspace checks and review import/call ordering (balanced).

## Rollout and rollback

No infrastructure or persistence migration. Existing workspace build compiles the
new modules into dist; verify compiled output loads. Revert only this refactoring's
diff if needed, preserving the user's other working-tree changes.

## Docs impact

Update the workspace README module map and walkthrough reading references.
Architecture/runbook/ADR changes: none; these are reversible internal boundaries.

## As-built

Verified locally. The dispatcher is 60 lines, with AWS operations in `task-aws.ts`,
watcher orchestration in `watch-task.ts`, release wiring in `release-task.ts`, and
documented shared contracts in `runtime-types.ts`. Existing type imports through
`task-runtime.ts` remain valid. New helpers name task-identity extraction, parallel
probes, terminal watcher publication, candidate registration and guarded service update.

All four acceptance scenarios pass against the working tree. Baseline was 54 tests;
the final suite has 57 after supplemental tests for completed candidate observation,
observed rollback, and watcher error publication. Supplemental tests were added after
extraction; they are additional verification, not claimed test-first evidence.

Final commands from the repository root: touched-file Prettier/ESLint, workspace
typecheck, all 57 tests across 12 suites, workspace build, compiled
`node automation/harness-buy-check/dist/main.js evaluate`, and `git diff --check`.
All pass. The compiled evaluation reports expected good/blocked/bad outcomes and
simulated rollback. No Docker build or live AWS test was run; synthetic tests do not
establish live deployment success. No public API, schema or AWS payload change was made.

Docs impact complete: workspace README module map and walkthrough Stops 4/7 and 5/7
now identify the extracted files. No architecture edits or ADR are needed. No design
deviation; existing handwritten parsing was retained intentionally for compatibility.
