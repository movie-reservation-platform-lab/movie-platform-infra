# Disposable experiment operator

This trusted operator is separate from the Harness identity. It keeps account
lifecycle, pre-allocation policy and observed cleanup in an owner-only JSON
record outside every Git worktree. It never stores credentials or a delegate
token. AWS execution uses the existing human SSO target/profile preflight,
argument arrays (no shell), fixed operations and a one-minute subprocess timeout.

From the infrastructure repository root:

```sh
npm run sandbox:experiment -- --help
npm run sandbox:experiment -- prepare --record /absolute/private/trial.json
npm run sandbox:experiment -- check-configuration --record /absolute/private/trial.json
npm run sandbox:experiment -- render-config --record /absolute/private/trial.json --inputs /absolute/private/inputs.json --out /absolute/private/cdk.json
npm run sandbox:experiment -- inspect --record /absolute/private/trial.json
```

`prepare` deliberately writes synthetic, unapproved data and never overwrites a
record. Fill the record locally with a fresh unique account correlation and the
verified identity, entitlement, artifact, recovery-schedule and cost evidence.
`check-configuration` exits 2 with separate allocation/admission blockers; it
needs no credentials, account or network. `sample` prints the same synthetic
shape. Existing runtime files must be owned by the operator, regular mode 0600,
and smaller than 1 MiB. Parent paths cannot traverse symbolic links. The operator
rejects records and target paths inside Git, including ignored directories.

The render inputs file has exactly these fields:

```json
{
  "allowedIngressCidrs": ["192.0.2.1/32"],
  "toolsImage": "111111111111.dkr.ecr.eu-central-1.amazonaws.com/tools@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "delegateImage": "111111111111.dkr.ecr.eu-central-1.amazonaws.com/delegate@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "delegateTokenSecretArn": "arn:aws:secretsmanager:eu-central-1:222222222222:secret:experiment/exp-harness-buy-check/delegate-ABCDEF",
  "harnessAccountId": "synthetic-account",
  "harnessManagerUrl": "https://app.harness.io"
}
```

Rendering requires an account already reconciled as ready. It derives the
account, experiment, region, image pair and lease from the operator record. The
CDK app independently validates the resulting private configuration. Rendering
does not establish deployment or trial success.

`create`, `status`, `admit`, `cleanup` and `retire` show a local preview unless
`--execute` is present. Executing those operations is a separate live operator
action; ordinary validation never does it. Creation first atomically persists
and fsyncs intent. Any lost response becomes `unknown`; repeating create is
refused. `status --execute` reconciles one request, scanning at most ten pages
when the response was lost, and refuses absent or ambiguous matches. Run it again
later for asynchronous creation; the process never polls forever. Correlation
must be a suffix of the unique account name.

`admit --execute` verifies the exact protected control outputs, experiment and
workload identity, enabled cleanup schedule with its fixed target/input, and a
confirmed cleanup-alert subscription. It creates the DynamoDB lease using
`attribute_not_exists(experimentId)` so retries cannot reset admission counters.
The app's trusted deployment/setup still installs the protected control and
workload stacks and notification route. This CLI does not deploy those stacks,
create Harness access, publish/verify artifacts, calculate current prices, or
install management-account recovery scheduling. Each is a prerequisite with
explicit evidence; missing evidence blocks allocation.

`cleanup --execute` invokes only the cleanup ARN obtained from the exact control
stack. It records actual observed resources. A deletion request, a `COMPLETE`
label with leftovers, or a revoked credential alone cannot mark workloads
removed. Repeating cleanup is the supported partial-failure recovery. Preserve
the control resources until cleanup verifies absence and evidence is exported.
Before deleting the control stack, capture its exact deployed physical inventory:

```sh
npm run sandbox:experiment -- capture-controls --record /absolute/private/trial.json --execute
# Export the agreed evidence, then delete the exact control stack with the trusted CDK operator.
npm run sandbox:experiment -- finalize-controls --record /absolute/private/trial.json --execute
npm run sandbox:experiment -- retire --record /absolute/private/trial.json --execute
```

`capture-controls` binds the full deployed template hash and stack ARN to exact
DynamoDB tables, versioned S3 buckets and log groups. It also captures legacy
Lambda default log names derived from exact CloudFormation function identities.
Unknown resource types, unsupported retained resources, incomplete inventory or
a changed template block finalization. An old stack already deleted without a
captured manifest cannot be declared clean or retired by guessing its resources.

`finalize-controls` first verifies the captured stack is actually deleted. It
then removes only captured remnants and verifies each absent. Versioned S3
cleanup includes object versions, delete markers and multipart uploads, uses the
expected account owner on every S3 call and stops after ten batches/pages.
Access denied and ambiguous errors remain blockers. Repeat finalization for
asynchronous deletion or a bounded partial cleanup; its manifest remains durable.
Control deletion requires evidence export first because finalization deletes
remaining inventory objects and logs. Neither command runs without `--execute`.

`retire` requires persisted observed control absence and repeats actual resource
absence checks immediately before Organizations closure. Read-only verification
failure leaves the account unchanged. A lost close response remains
`closure-unknown`; another retire is refused and `status --execute` inspects the
actual account state without resubmitting closure. Pending closure and `CLOSED`
are separate results; neither means the account immediately stops occupying an
organization slot. Account closure remains distinct from resource cleanup.

Mutations hold an exclusive adjacent `.lock` file. A crashed process may leave
that lock. A trusted operator must establish that the original process is gone,
inspect/reconcile account state, and remove the stale lock before recovery. Do
not delete a lock while another operation is running or reset an unknown account
record to planned.

Local evidence: the initial compiling policy skeleton produced 3 intended
behavioral failures; the initial lifecycle skeleton produced 3 intended failures
(intent/unknown response, observed cleanup, retirement refusal). Implementation
made both green. Focused checks:

```sh
npm run build --workspace @movie-platform/experiment-sandbox
npm test --workspace @movie-platform/experiment-sandbox
npm run build --workspace @movie-platform/experiment-sandbox-operator
npm test --workspace @movie-platform/experiment-sandbox-operator
```

All tests use synthetic files and fake cloud boundaries. No live account,
workload, IAM, entitlement, expiry enforcement or billing result is established
by these tests.

Review fixes: six compiling regression assertions first failed because mismatched
request/account identities were persisted and stack disappearance alone allowed
closure. The completed tests verify immutable account correlation, exact captured
retained-resource cleanup, bounded S3 retries, denied/unknown observations and
ambiguous closure recovery. All use fake AWS subprocess/preflight boundaries.

Cleanup records preserve `cleanupStatus` and bounded `cleanupBlockers` in both
execution summaries and later `inspect` output. Only registered safe messages
are persisted from cleanup; unknown diagnostics become a generic inventory/retry
instruction so raw service errors or task output cannot enter the record.
