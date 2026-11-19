# Walkthrough: Harness trial and experiment sandbox

- Target: branch `ai/141-harness-buy-check`, uncommitted working tree (Harness trial + sandbox workspaces)
- Mode: review
- Pinned base: 63048c6 (merge base with main)   Head at start: 027865a; restarted from Topic 1 at 3f3ed86 after the zod split
- Started: 2026-10-24
- Position: Topic 7/8 — Trial runtime; inner Stop 3/7 — AWS transport (`aws-cli.ts`); launcher scheduler next within this stop
- Status: in progress

## Topics

| # | Topic | Files | Status |
|---|---|---|---|
| 1 | Shared contract | packages/experiment-sandbox/ | done |
| 2 | Sandbox CDK app: config + control stack | apps/experiment-sandbox/lib/config.ts, lib/control-stack.ts, bin/ | done |
| 3 | Sandbox CDK app: workload stack | apps/experiment-sandbox/lib/workload-stack.ts, test/stacks.test.ts | done |
| 4 | Launcher and cleanup functions | apps/experiment-sandbox/runtime/, test/launcher.test.ts, test/cleanup.test.ts | done |
| 5 | Operator CLI | automation/experiment-sandbox/ | done |
| 6 | Trial decisions | automation/harness-buy-check/src/{run-case,release,watch,probe,evaluate}.ts | done |
| 7 | Trial runtime | automation/harness-buy-check/src/{task-runtime,aws-cli,cli}.ts, Dockerfiles | current |
| 8 | Repo wiring | package.json, eslint.config.mjs, .prettierrc.harness-trial.json, README.md | pending |

## Findings

### Open
- [x] **Engineer REVIEW comments on `packages/experiment-sandbox/src/index.ts`** (Topic 1, should) — fixed, see Done:
      helpers named after types (`object`, `text`, `date`, `bool`, `number`); nested inline sub-types in
      `SandboxRecord`; missing docs on `RetiredControls*`; one 600-line file mixing JSON guards, record
      types, parsing, and admission policy. Proposed split: record types / json guards / record parser /
      admission policy / index re-exports. Pending decision: hand-rolled validation vs schema library.
- [x] **Document that only the operator can create accounts** (Topic 1 → lives in Topic 5 code, should).
      Requested by engineer. Docstring on `AwsCliSandboxCloud.create` (`automation/experiment-sandbox/src/aws-cli.ts:~133`)
      and `createAccount` (`automation/experiment-sandbox/src/lifecycle.ts:25`); later enforce in CI/IAM.
- [x] Topic 1, finding 1 (should): timestamps without a zone read as local time; `2026-02-30` rolled into March.
      Fixed: `isoTimestampSchema = z.iso.datetime()` (UTC, trailing `Z`); `isUtcTimestamp` used by the CDK config check.
- [x] Topic 1, finding 2 (should): package rules barely tested. Fixed: `test/admission-policy.test.ts` (one change, one
      blocker per case) and `test/sandbox-record.test.ts` (timestamps, lease, caps, images, accounts, manifest). 11 → 56 tests;
      mutation check: breaking future-evidence and offset rules fails 2 tests.
- [x] Topic 1, finding 3 (should): `identifiers.ts` undocumented exports, `title` helper. Fixed: TSDoc, `capitalize`.
- [x] Topic 1, finding 4 (nit): record parsed then discarded in `admissionBlockers`. Fixed: `checkRecord` parses once;
      rule functions read the parsed copy; the `startsWith('invalid record')` check is gone.
- [x] Topic 1, finding 5 (nit): stale README evidence paragraph. Fixed.
- [x] Topic 1, finding 6 (should): limits hardcoded in ~12 places across four workspaces. Fixed: `SANDBOX_LIMITS` in
      `packages/experiment-sandbox/src/sandbox-limits.ts`, imported by record schema, policy, CDK config, launcher,
      admission handler, render-config, sample record, and the trial tool's 45-minute waits. Long term: named limit
      profiles in code, record selects one by name.
- Topic 1, extra nits: [x] `parseRetiredControls` takes a `ControlStackLocation` object (fixed). Deferred: one message
  ("identity mismatch or duplicate") covers two different failures; control-character check misses DEL/C1.

- [x] Topic 2, finding 1 (blocking): `ecs:DeregisterTaskDefinition` scoped to task-definition ARNs, but AWS's service
      reference lists no resource types for it (must be `*`). Fixed in deletion role and cleanup Lambda; the same bug
      (`ecs:DescribeTaskDefinition` on watch/release roles, Topic 3) fixed too. Regression test: `stacks.test.ts`
      "actions AWS cannot scope are only granted on \"*\"" (fails on the old code).
- [x] Topic 2, finding 2 (should): CDK config and operator render-config validate the same fields with copied rules
      (ingress, secret ARN, Harness ID). Fixed: `packages/experiment-sandbox/src/sandbox-config.ts` (config + render
      inputs schemas); both sides call it. Error helpers moved to `schema-parse.ts`.
- [x] Topic 2, finding 3 (nit): launcher `RunTask` allowed on every `${experimentId}-*` family; PassRole blocks misuse
      today. Fixed: nine trial families only; test added.
- [x] Topic 2, finding 4 (question → split): IAM moved to `apps/experiment-sandbox/lib/control-permissions.ts`;
      synthesized templates byte-identical before/after.
- [x] Topic 2, engineer request: control-stack constructor split into named methods (`createStateTable`,
      `createHandlers`, `scheduleCleanup`, `exportOutputs`, ...); templates byte-identical.
- [x] Topic 2, engineer request: `stacks.test.ts` restructured to the repo convention (`describe` stack › area ›
      `it` behaviour, as in `test/infra.test.ts`); bundled tests split (12 → 21); config cases moved to the package.
- Topic 4: Lambda bundle is ~3 MB unminified (not changed).
- Topic 2, question: no SCPs and no CloudTrail trail/export exist in this change; CloudTrail event history lives in the
      sandbox account and is lost with it.

- [x] Topic 3, engineer request: workload-stack constructor split into named methods (300 → 63 lines); trial IAM moved
      to `lib/workload-permissions.ts`; named parameter types; templates byte-identical.
- [x] Topic 3/4, engineer request: `launcher.test.ts` and `cleanup.test.ts` restructured (describe › it, named
      `it.each` cases, every rejection checks its message); 12 → 20 tests.
- [x] Topic 3, finding 1 (should): trial task logs (incl. release `reverted: true` evidence) live only in the workload log
      group: 1-day retention, deleted by automatic cleanup at expiry, never exported. Fixed: log group moved to the
      control stack (1-week retention); deletion role lost all `logs:` permissions; tests added.
- [x] Topic 3, finding 2 (question): delegate `MANAGER_HOST_AND_PORT` hardcoded to `https://app.harness.io`; confirm
      against the Harness account's delegate install page. Fixed: `harnessManagerUrl` render input, validated as
      `https://*.harness.io`; the real value is still to be copied from Harness.
- Topic 3, note (accepted by engineer): `workload-stack.ts` is still 641 lines (docs + named types); delegate and trial task definitions
      could move to their own files.

- [x] Topic 4, engineer request: typescript-style + typescript + readability-maintainability pass over runtime/.
      `aws-handlers.ts` split into control-environment, aws-clients, state-table, workload-observer, and one file per
      handler (aws-handlers.ts is now the bundle entry only). `launch()` split into named steps; `cleanup()` computes
      status once. Shared zod schemas for launch request, lease row, watch row, cleanup request in
      `packages/experiment-sandbox/src/control-state.ts`; `CLEANUP_BLOCKERS` shared with the operator sanitizer;
      `watchHeartbeatMaxAgeSeconds` replaces three `30000` literals. Covers Topic 4 findings 1, 2, 4, 5.
- [x] Topic 4, finding 3 (question → option B): the 5-minute schedule stops trial tasks running longer than 45 + 5
      minutes (`runtime/run-limit.ts`, `SANDBOX_LIMITS.runLimitGraceMinutes`); cleanup gained scoped `ecs:DescribeTasks`.
- [x] Topic 4, question → option B: while the stack is provisioning, cleanup only cancels a running update and
      reports BLOCKED; full teardown after the stack settles. Release-revision removal skips revisions the stack owns.

### Notes for later topics
- Topic 4: `maxRunMinutes` only bounds client-side waiters; check whether anything stops a task in AWS after 45 minutes.
- Topic 3: [x] watch/release `ecs:DescribeTaskDefinition` now on `*` (fixed with Topic 2 finding 1).
- [x] Topic 5: type-word JSON helpers replaced by response schemas and named operations.
- Topic 6: `run-case.ts:3-5` redefines `CaseId`/`StepId` instead of the contract types;
  `native-deployment.ts:26` has a type-word helper `string(...)`.

### Follow-up
- **Sandbox OU and SCP guardrails** (Topic 5, future design work). This change creates
  dedicated member accounts but does not place them under a sandbox OU or attach/test an
  SCP. Plan this separately as organization-level governance: constrain maximum member
  account permissions, delegated deployment paths, region/services, IAM/PassRole and
  logging/cleanup tampering; preserve a separately administered teardown path; test both
  expected allows and denies. SCPs do not grant access and do not constrain management
  account principals or every service-linked role. Repository evidence: `aws-cli.ts:64`
  has only a TODO; no implementation plan exists. KB basis: [[Guarded Cloud Changes by
  AI Agents]], [[AWS Delegated Deployment Authority]], [[Agent Security Extended Research]].

### Questions

### Dropped

### Done
- (uncommitted) **Split and documented trial task runtime** (Topic 7, Stop 1/7).
  `task-runtime.ts` remains the dispatcher and compatibility export; `task-aws.ts`,
  `watch-task.ts`, `release-task.ts`, and `runtime-types.ts` own focused responsibilities.
  Extracted probe, terminal-publication, registration, update and identity helpers.
  All 57 workspace tests, typecheck/build, compiled offline CLI, lint/format and diff
  checks pass. See `docs/plans/harness-task-runtime-readability.md` for evidence/limits.
- (uncommitted) **Extracted release orchestration and observation decisions** (Topic 6,
  Stop 5/7) — `deployCandidate`, `assertReleaseMonitoringReady`,
  `evaluateDeploymentObservation`, `hasLostWatcherHeartbeat`, and a shared `buildFailure`.
  Named attempt/history types keep fixed identity separate from remembered observations.
  Four added characterization scenarios passed before extraction: lost readiness after
  registration, remembered active failure, rollback lacking failure evidence, and wrong
  completed image. All 54 workspace tests, typecheck, lint, formatting and diff checks pass.
- (uncommitted) **Completed `parseAwsResponse` TSDoc** (Topic 5, inner Topic 6/9,
  nit) — documents the schema, untrusted value, operation label, inferred return,
  and redacted failure contract. Prettier, ESLint and operator build pass.
- (uncommitted) **Completed private-path and record-save parameter documentation**
  (Topic 5, inner Topic 3/9, nit) — `record-file.ts` now explains `path`, `record`,
  and `create`; inspected with `git diff --check`.
- (uncommitted) **Contract package split + zod** — `field-schemas.ts`, `sandbox-record.ts` (schemas, inferred
  documented types), `parse-record.ts`, `admission-policy.ts`, `index.ts` re-exports only. zod 4.6.7 pinned;
  trial Dockerfile copies `node_modules/zod`; package README updated. Unknown-key errors listed first.
  Checks: validate:experiment-sandbox, validate:harness-buy-check (118 tests), synth, format, lint, boundaries pass.
  Not run: docker build of the trial images.
- (uncommitted) **Operator-only account creation docstring** on `AwsCliSandboxCloud.create`
  (`automation/experiment-sandbox/src/aws-cli.ts`) and `createAccount` (`lifecycle.ts`) — prettier + eslint pass.

## Outside the walked change (found during pinning)

- `AGENTS.md` has one uncommitted line (`typescript-style` skill); commit 027865a is
  one line behind its `.ai/` source (`render.py --check` passes only on the working tree).
- `scripts/validate-stack.sh:6` computes `REPO_ROOT` as `../../../..` from `scripts/`,
  a leftover from its old `.ai/skills/aws-cdk-iac/scripts/` location; should be `..`.

## Topic changes

Topic 6 now shows inner-stop progress in every walkthrough reply:

| Stop | Reading focus | Status |
|---|---|---|
| 1/7 | `run-case.ts`: explicit gate → watch → release workflow | done |
| 2/7 | `run-case.ts`: waiter, identity and timeout | done |
| 3/7 | `release.ts`: baseline and pre-update checks | done |
| 4/7 | `watch.ts`: readiness, sample attribution and coverage | done |
| 5/7 | `release.ts`: completion, rollback evidence, heartbeat and timeout | done |
| 6/7 | `probe.ts`: HTTP probe validation | done |
| 7/7 | `evaluate.ts`: offline scenarios and their evidence limits | done |

Topic 7 reading stops (split further within a stop as needed):

| Stop | Reading focus | Status |
|---|---|---|
| 1/7 | Task dispatch: gate, watch, release in `runTask` | done |
| 2/7 | Runtime configuration and its validation | done |
| 3/7 | AWS transport and launcher scheduler | current |
| 4/7 | Watcher runtime: `watch-task.ts` orchestration and `task-aws.ts` observations/publication | pending |
| 5/7 | Release adapter: `release-task.ts`, recipe rendering and native deployment mapping | pending |
| 6/7 | CLI assembly and delegate identity | pending |
| 7/7 | Images and pipeline wiring | pending |

The old topic map mentioned `gates.ts`, which does not exist. Runtime gate behavior
is in `task-runtime.ts` and stays with parent Topic 7; native AWS deployment mapping
and recipe rendering also belong to that runtime topic.

- Topic 5 explanation order agreed with the engineer; explain mode, one small section
  per message, advance only on request. Working-tree target pinned at HEAD `74b2964`,
  including staged, unstaged and untracked operator files. Inner topics:
  1. Experiment record — `sample.ts` (done).
  2. Reading and validating records — `record-file.ts` (done).
  3. Atomic record saves — `record-file.ts` (done).
  4. Exclusive record access — `record-lock.ts` (done).
  5. Account creation and reconciliation — `lifecycle.ts` (done).
  6. Reaching AWS — AWS adapters, one at a time (done).
  7. Configuration and admission (done).
  8. Cleanup and retirement (done).
  9. CLI wiring (done).

- Resumed parent Topic 6 after commits `a8d2569` (shared contracts/tests) and
  `39fd2ff` (operator). HEAD observed at `39fd2ff`; trial decisions remain working-tree
  additions. Continue explain mode in small sections; start with `run-case.ts` sequencing,
  then its waiter before moving to the remaining decision modules.

- Topic 5 stays open for the engineer to read one file at a time. Suggested order:
  `sample.ts`, `record-file.ts`, `record-lock.ts`, `lifecycle.ts`, `cli-arguments.ts`,
  `cli.ts`, then `aws-cli.ts` and its focused AWS adapters as their operations arise.
  Explain the purpose and one flow before introducing the next file.

## Topic 5 readability refactor — resumed 2026-10-26

Scope: continue the authorized TypeScript, TypeScript style, clean architecture and
two-iteration readability review. Existing staged work and unrelated changes remain intact.

- The handoff's first review led to separating the AWS runner, Organizations calls,
  lease admission, cleanup invocation, manifest rules, resource absence checks and
  versioned-bucket cleanup. `aws-cli.ts` now wires those adapters to narrow lifecycle ports.
- AWS responses are validated with Zod before use. Runtime validation checks external
  values; TypeScript checks how the validated values are used inside the program.
- Lifecycle operations own admission, closure-status reconciliation and manifest saves.
  Creation distinguishes a definite rejection from an ambiguous outcome; unknown creation
  results still require status reconciliation before another create request.
- Cleanup blocker sanitization no longer rejects a large response after teardown has
  acted. Only the fixed safe messages and one generic replacement reach the record.
- Resumed review round 1: restored the existing `check-configuration` alias, rejected
  inherited object names as commands, and checked every public command in help output.
- Lock tests exposed native filesystem errors that failed `instanceof Error` across
  Jest's VM boundary. Structural error-code checks restore live/stale lock diagnostics
  and tolerate an already-removed lock. A regression for simultaneous command/removal
  failure failed before the fix; an `AggregateError` now retains both errors.
- Resumed review round 2: no material findings. Reviewer: `readability-maintainability`,
  balanced tier / medium effort (`gpt-6.1-sol`), read-only; no escalation.

Verification from the repository root: `npm run check:harness-trial` passed on the
final working tree: formatting, ESLint, workspace builds/typechecks, all four workspace
test suites, offline CDK synth with `--no-lookups`, dependency boundaries and
`git diff --check`. The operator has 57 passing tests across six suites. The second
review also checked the final lock implementation after lint-driven restructuring.
No live AWS operation, image publication, commit or deployment is part of this continuation.

## Context read

- `movie-platform-environments/docs/research/harness-buy-check-codebase.md` and `harness-buy-check-external.md`
  (requirements R1–R21, security preconditions §5: scratch targets only, one delegate role per environment,
  digest-pinned delegate image, no deploy credentials in gate steps).

## Not verified

- No plan or issue #141 found in this repository; review is against workspace READMEs and code.

## Focused readiness review — 2026-11-19

At the engineer's request, switched from the remaining interactive stops to a
focused review of uncommitted runtime, CLI, recipe/deployment mapping, images,
pipeline, tests and repository wiring against HEAD `5730b6b`. This does not mark
the unread walkthrough stops as explained to the engineer.

- No experiment-blocking defect established in the runtime paths reviewed.
  The dispatcher, watcher, release adapter and AWS observations now have separate
  modules. Remaining readability debt: type-word JSON helpers, generic local names,
  the multi-command CLI function, and runtime-config's double type assertion.
- Helper defect fixed before publication: `scripts/validate-stack.sh:6` now resolves
  the repo root one level above `scripts/`. Shell syntax and an isolated evaluation
  of the path initialization pass; the full helper was not executed. It is not
  part of the experiment's execution path.
- AWS transport replaces provider errors with a generic message. This limits
  diagnosis of live failures; defer improvements only with that limitation understood.
- PASS: `TMPDIR=/var/tmp npm run check:harness-trial`, including formatting,
  lint, builds/typechecks, 255 tests across the four workspaces, offline synth,
  dependency boundaries and diff checks. Compiled offline evaluator also passed.
  The initial default-temp run failed because this environment has `/tmp/.git`;
  the operator correctly rejected its private test fixtures there. No guard was weakened.
- NOT_RUN in this review: full repository CI, container builds/startup, image
  publication, Harness pipeline import/execution and live AWS acceptance. Delegate
  compatibility, scratch-project/delegate selection, immutable image inputs and
  live cleanup evidence remain preparation/acceptance work, not offline proof.
