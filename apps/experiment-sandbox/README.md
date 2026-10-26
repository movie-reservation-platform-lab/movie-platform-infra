# Disposable experiment CDK application

This app synthesizes two stacks. `exp-<id>-control` owns the protected launcher,
lease table, durable inventory, expiry schedule and cleanup. `exp-<id>-workload`
owns the no-NAT VPC, scoped ALB, recommendation service, isolated trial task
recipes and delegate. The synthetic fixture contains no usable artifacts or
credentials. Synthesis creates templates and bundled Lambda assets only.

To read the app, start with `lib/config.ts` (validate operator input), then
`lib/control-stack.ts` (protected launch/cleanup resources) and
`lib/workload-stack.ts` (the disposable service and tasks). Runtime decisions
live in `runtime/launcher.ts` and `runtime/cleanup.ts`; `runtime/aws-handlers.ts`
connects those decisions to AWS. The pure shared package owns registered task
names, so provisioning, launch lookup and cleanup use the same identities.

From the repository root:

```sh
npm run validate:experiment-sandbox
npm run synth:experiment-sandbox -- --no-lookups
```

Live provisioning remains a separately authorized operator operation. The app
requires an explicit `sandboxConfig` JSON file matching `fixtures/synthetic.json`;
there are no account, credential, image or ingress defaults. Supply the approved
real account's availability-zone context explicitly for offline real-config
synthesis. Keep that config and the operator record outside Git.

Deploy control first, confirm its cleanup schedule and notification route, then
use the trusted operator admission command to initialize the conditional lease.
Only afterward deploy workload. A protected CloudFormation admission resource
checks the immutable expiry/cutoff and admitted lease before every workload
resource can be allocated. CloudFormation imports preserve that dependency.

Initial service creation installs the immutable healthy baseline with alarm
monitoring disabled. It is setup, not a successful release trial. The first
trusted release task may arm the exact configured alarms only from that baseline,
after the watcher is fresh and every actual alarm is `OK`. Subsequent releases
require monitoring already enabled. Normal releases use ECS-native 10% canary
traffic for five minutes and a five-minute bake, with desired count two and a
maximum of four service tasks. The recommendation container listens on 8082.

The delegate task role can invoke only the launcher. Launcher inputs are exactly
`{experimentId, caseId, stepId}`; registered cases are `good`, `blocked`, `bad`,
and steps are `gate`, `watch`, `release`. Calling the same IDs polls the same task.
Protected DynamoDB reservations enforce one active case, four concurrent and
sixteen total accepted standalone launches. The full trusted RunTask request is
persisted before submission and reused with a deterministic client token. Gate
success is observed from the exact ECS task recipe and exit code. Watch readiness
comes from its separate, tightly scoped observation row.

Before expiry, each 5-minute schedule run stops any trial step task that has run
longer than `SANDBOX_LIMITS.maxRunMinutes` plus `runLimitGraceMinutes` (45 + 5
minutes). ECS has no task timeout, and a hung step would otherwise block every
other case until expiry; the launcher then reports the stopped step as `FAILED`.
Service tasks are never stopped this way.

The immutable expiry independently disables admission and repeatedly reconciles
the exact workload stack, running tasks and experiment task-definition families.
An accepted delete request returns `DELETING`; only fresh absence observations
return `COMPLETE`. Failures preserve S3 inventory and return `BLOCKED`, with a
protected alarm notification route. Cleanup's CloudFormation role has a bounded
regional EC2 deletion allowlist because route-association teardown cannot rely
on tags uniformly. It has no resource-creation permissions. Only cleanup can
pass that role for the exact fixed workload stack; the dedicated account is an
additional isolation boundary.

Task logs (service, trial steps and delegate) go to `/experiment/<id>/tasks`,
which the control stack owns. Automatic cleanup deletes the workload at lease
expiry but cannot delete that log group, so the trial evidence (for example the
release step's `reverted: true`) survives until it is exported. The delegate's
Harness manager URL comes from the render inputs (`harnessManagerUrl`).

Export evidence and capture the complete deployed control manifest before
explicit trusted control destruction. State, the versioned inventory bucket
(including versions) and all provider logs are owned by CloudFormation with
`DESTROY`. `ControlLogGroupNames` lists the owned log groups. Verify each captured
resource's absence afterward; stack deletion alone is insufficient. Account
retirement is a separate trusted organization-operator action.

Before live allocation, the operator must supply verified good/bad application
images, the published trial-tools image and a compatible delegate image, all by
digest; the delegate token secret and confirmed alert route; exact account and
regional target verification; suitable zero-charge Harness entitlement; and a
complete forecast for service/delegate tasks, public IPv4, ALB, logs, images,
control resources and cleanup within the agreed allowance. The fixed delegate
size is 2 vCPU/4 GiB; compatibility and its cost remain runtime prerequisites.
No live operation or artifact verification is represented by these offline tests.
