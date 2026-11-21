# Harness trial commands

This workspace owns the local commands used by the Harness trial. It consumes
the pure `@movie-platform/experiment-sandbox` contract and never imports a CDK
application. Harness schedules the steps; the protected launcher decides whether
each fixed task can run. The delegate has Lambda invoke authority and no direct
ECS launch, role-passing or service-update authority.

To follow one run, start with `src/run-case.ts` (step ordering), then
`src/release.ts` (the release decision). `src/watch.ts` judges candidate samples;
`src/probe.ts` validates HTTP responses. Inside isolated tasks, `src/task-runtime.ts`
dispatches gate, watch and release steps. Read `src/watch-task.ts` for watcher
orchestration, `src/release-task.ts` for the release port wiring, and `src/task-aws.ts`
for ECS observations, alarm reads and metric/state publication. Their shared injected
capabilities and results live in `src/runtime-types.ts`; existing imports through
`task-runtime.ts` still work. `src/cli.ts` owns command inputs.
A release is reported as launched only when a task identity was observed.

From the infrastructure repository root:

```sh
npm run validate:harness-buy-check
npm run trial:harness -- --help
npm run trial:harness -- evaluate
npm run trial:harness -- doctor
npm run trial:harness -- doctor --record /private/sandbox-record.json
npm run trial:harness -- dry-run good --record /private/sandbox-record.json
```

`evaluate` uses synthetic port responses and verifies the exact expected
behaviors: success; failed gate with no watch/release task; failed active
deployment followed by original revision. Its successful exit means the local
verification passed. It prints `mode: offline`, `liveStatus: NOT_RUN` and
`artifactVerification: NOT_RUN`. It cannot establish image health, an ECS revert,
Harness functionality, cost, entitlement or isolation in a real account.
`doctor` reports local record blockers without reading credentials or calling AWS.
`dry-run` prints fixed request shapes only; inputs are never labeled observed
artifact identities.

After explicit authorization for live execution, the trusted operator supplies
the admitted private record, actual launcher output and a scoped sandbox profile:

```sh
npm run trial:harness -- good --record /private/sandbox-record.json --launcher "$LAUNCHER_ARN" --profile sandbox-experiment
npm run trial:harness -- blocked --record /private/sandbox-record.json --launcher "$LAUNCHER_ARN" --profile sandbox-experiment
npm run trial:harness -- bad --record /private/sandbox-record.json --launcher "$LAUNCHER_ARN" --profile sandbox-experiment
```

These commands really invoke the protected Lambda. They do not provision the
sandbox or grant cloud authorization. `blocked` and `bad` remain nonzero failures
in live execution; a failed trial is not converted into a successful pipeline.
Record whether the exact expected failure and revert happened separately.
Commands use argument arrays, a 30-second subprocess ceiling, bounded AWS retries
and a 45-minute step waiter. Missing observations, AWS errors and timeouts fail.
Provider error payloads are withheld from public command output; diagnose exact
failures in protected task logs and local record validation.

The operator commands also support `--step gate|watch|release`. The Harness
pipeline uses a separate installed-delegate command:

```sh
node /opt/trial/automation/harness-buy-check/dist/main.js delegate good --step gate
```

`templates/pipeline.yaml` invokes that command for each step. The CDK app installs
`EXPERIMENT_ID`, `SANDBOX_ACCOUNT_ID`, `SANDBOX_REGION` and `LAUNCHER_ARN` in the
delegate environment. No operator journal or local-file mount is needed inside
Fargate. The command requires ECS task credentials and accepts only case/step
IDs; it cannot take launcher, record, profile, image or command overrides.
Use a scratch project assigned only to this dedicated delegate. Verify suitable
zero-charge entitlement before allocating workloads. The template has not been
imported into or executed by Harness.

Do not distribute human profiles or management-account credentials to the
delegate. Its IAM role permits invocation of only the installed launcher. The
protected launcher independently enforces the admitted lease, observed gate,
watcher readiness and atomic launch limits. Its policy remains authoritative if
an untrusted script changes its own environment. Nonzero exits stay visible to
Harness.

The task-runtime image contains Node >=22, AWS CLI v2, this compiled workspace
and the compiled pure contract package. Build both packages locally, then build
the Dockerfile from the repository root with approved digest-pinned Node and
official AWS CLI v2 image inputs of the same architecture. It copies the AWS CLI
distribution into the Node base and checks both executables during the build:

```sh
npm run build --workspace @movie-platform/experiment-sandbox
npm run build --workspace @movie-platform/harness-buy-check
docker build --build-arg NODE_IMAGE="$PINNED_NODE_IMAGE" --build-arg AWS_CLI_IMAGE="$PINNED_AWSCLI_IMAGE" -f automation/harness-buy-check/Dockerfile -t harness-trial-tools .
docker run --rm harness-trial-tools evaluate
docker run --rm harness-trial-tools doctor
```

Image publication is a separately authorized action. The sandbox app consumes
the resulting tools image by digest; it never builds service images. Its fixed
command is `task <gate|watch|release> --case <good|blocked|bad>`. The launcher
supplies immutable task definitions with operator-owned `TRIAL_RUNTIME_CONFIG`.
The record never accepts a command, network, role, task-definition or image
override from Harness. The config parser rejects unknown fields.

`Dockerfile.delegate` copies Node, AWS CLI and the compiled tool from the approved
tools image into an approved digest-pinned Harness delegate base. It preserves
the delegate's original startup command and user. Choose glibc/architecture
compatible image inputs; its build fails if the copied tools cannot execute.

```sh
docker build --build-arg TRIAL_TOOLS_IMAGE="$PINNED_TRIAL_TOOLS_IMAGE" --build-arg HARNESS_DELEGATE_BASE_IMAGE="$PINNED_HARNESS_DELEGATE_IMAGE" -f automation/harness-buy-check/Dockerfile.delegate -t harness-trial-delegate .
docker run --rm --entrypoint node harness-trial-delegate /opt/trial/automation/harness-buy-check/dist/main.js evaluate
```

Protected tasks reuse in-process AWS SDK clients for ECS, CloudWatch and DynamoDB.
The workspace build bundles the clients into the compiled runtime. The delegate
uses the AWS CLI to invoke the launcher. These calls use the existing role for
each task. Image evaluation and the paired watcher/release tests run offline.

The gate performs the deterministic selected-case precheck without deployment
credentials. Watch publishes high-resolution `ProbeFailure` metrics in
`MoviePlatform/ExperimentSandbox`, dimension `ExperimentId`, and a protected
DynamoDB observation item keyed `${experimentId}#${caseId}#watch`. Startup writes
healthy metrics before waiting for every configured alarm to become `OK`; only
verified baseline `/ready` and `/recommendations` responses make it ready.
`ready`, `heartbeatAt` and `verdict: OK|FAIL` enforce startup/freshness;
`candidateVerdict: PENDING|PASS|FAIL` conveys measured candidate coverage.

Release refuses a moving or unapproved baseline, stale watcher or non-OK alarm.
The untouched CloudFormation recipe starts with deployment-alarm monitoring
disabled so stack creation does not race an absent watcher. This exception is
accepted only when the observed service task definition equals the immutable
recipe ARN. The configured alarms must still exist and report actual `OK`
states. Immediately before the first candidate update, release rechecks the
fresh watcher and alarms, then explicitly sets monitoring and rollback to
`true`. Disabled monitoring on any later revision is rejected before release.
It preserves the deployed recipe and applies S1's render/register/update
semantics through a small TypeScript function characterized against the existing
S1 fixtures. It removes registration-only response fields, preserves non-AWS
tags and changes only the selected image in the same repository. It enables ECS
alarm rollback; it never issues a second update to roll back a completed release.

Watch obtains task revision, image digest and private address from ECS, then
probes `/ready` and `/recommendations` on port 8082. Probes require HTTP 200 JSON:
readiness must identify `movie-recommendation-service` as ready, and the
recommendation envelope must contain valid nonempty recommendation items.
Each response has a 64 KiB body limit and a two-second deadline covering its body.
Healthy startup refreshes preserve established readiness while the next alarm
observation is pending; a failed probe or alarm observation revokes it.
ECS discovery and heartbeat publication each run on a five-second schedule.
HTTP probing runs independently every second. Each loop waits for its previous
operation to finish. Discovery must confirm the same task ARN, revision, digest
and private IP on either side of a candidate sample. The heartbeat carries the
older of the last discovery and probe times.
Every observed candidate task
needs at least 60 distinct sample times spanning 60 seconds. Coverage must arrive
within five minutes; old-revision responses cannot satisfy it. Monitoring
continues through the bake: a later failed sample remains failed after recovery.
Before updating ECS, release records the existing service deployment ARNs. It
then follows the new ARN through native `ListServiceDeployments` status and
waits for both running tasks to converge on the expected revision and digest.
A bad verdict
must occur while active, and the original revision/digest must be observed after
ECS reverts. Late failures, missing coverage and completed deployments requiring
manual recovery remain failures. Release task logs include `reverted: true` and
the observed original revision/digest only when that sequence was verified; a
generic launcher `FAILED` status alone cannot establish the expected bad case.
Protected lease cleanup handles cancellation;
these commands do not change account retirement state.

No live cloud action or Harness run has been performed by the offline tests.
