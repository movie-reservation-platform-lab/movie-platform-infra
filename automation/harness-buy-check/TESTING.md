# Local implementation evidence

No AWS resources, image pulls/builds, Harness pipeline import or service endpoints
were exercised. All test ports were synthetic. Live acceptance remains NOT_RUN.

Run from the infrastructure repository root:

```sh
npm run validate:harness-buy-check
npm run trial:harness -- evaluate
npm run trial:harness -- doctor
node automation/harness-buy-check/dist/main.js evaluate
```

The validation runs strict type checking, Jest and a distributable build. The
offline evaluator succeeds only for exact expected good/blocked/bad behavior;
live blocked/bad commands retain failed exits.

Test-first observations during implementation:

| Slice | Baseline command / intended failure | Result after implementation |
| --- | --- | --- |
| Sequencing, stale watcher, revision coverage and bounded wait | `jest --config automation/harness-buy-check/jest.config.cjs --runInBand`; 13 behavioral failures in a compiling scaffold (wrong green result, absent operations, no rejection) | 13 passing |
| S1 recipe compatibility | Existing `bash scripts/ecs-canary-spike/release.sh --self-test` passed; focused `recipe.test.ts` then failed 2 expectations (empty rendering, unsafe image accepted) | Existing fixture output preserved; 2 passing |
| Real task entrypoints | Focused `task-runtime.test.ts`: blocked gate incorrectly zero, missing observations incorrectly green | Failed exits and missing-alarm rejection verified |
| Eventual service consistency | Focused `release.test.ts`: original revision immediately after update incorrectly failed before active rollout | Bounded wait permits actual candidate rollout |
| Coverage deadline | Focused `gates.test.ts`: samples collected after five minutes incorrectly passed | Late samples excluded; deadline fails |
| Native ECS canary | Focused `native-deployment.test.ts`: 3 failures for native completion/revert/missing state | Native status recognized without rolloutState; unknown state fails |
| Pending task identity | Focused `task-runtime.test.ts`: desired-RUNNING, actual-PENDING task prevented baseline observation | Only actually RUNNING tasks are probed |
| Bootstrap monitoring | Focused `bootstrap.test.ts`: 2 failures (untouched baseline refused, actual pending alarm not read), nonbootstrap denial already passed | Exact recipe-only exception; fresh watcher/actual OK alarms required; first candidate explicitly enables monitoring/rollback |
| Bake failures, readiness interleaving and HTTP bodies | Focused `gates.test.ts`, `watch-readiness.test.ts`, `probe.test.ts`: 6 behavioral failures (minute-six failure ignored, false readiness publication, invalid/oversized/stalled bodies accepted) | 11 targeted checks passed; bake failures sticky, established readiness retained, bounded service JSON required |

Additional CLI/template and artifact-observation regressions cover unsupported
overrides, credential-free offline commands, no human credentials in isolated
task mode, redacted provider failures and no artifact observation inferred from
operator input. Focused CLI coverage was added alongside its delivery adapter;
it is not claimed as a red-before-green production slice.

Latest focused result: 48 tests in 11 suites passed, strict type check and build
passed. The tools container build and runtime smoke passed separately using local
candidate bases pinned by resolved digest; evaluate/doctor/aws-version ran with
networking disabled. Delegate-base compatibility/startup remains NOT_RUN.

Lead review regressions: `run-case.test.ts` first failed three assertions for
no-task failure/timeout and success without identity. The waiter now retains
observed task identity across timeout; a step name alone cannot prove launch.
All nine scheduler checks pass. The offline simulator explicitly supplies
synthetic task identities to satisfy the same contract; it still labels all
live/artifact evidence NOT_RUN.

Delegate handoff: the first compiling CLI scenario failed because the delegate
command did not exist; the CDK assertion failed because fixed sandbox context
was missing. The new command receives only installed launch coordinates and
ECS task credentials, schedules exact case/step IDs, and never reads the
operator journal. Five delegate checks and the updated CDK assertions pass.
Invalid account/region/identity/credential contexts fail before scheduler creation.
