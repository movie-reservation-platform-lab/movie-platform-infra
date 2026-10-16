# Implementation Plan: ECS Canary Deployment Alarm Spike (S1)

Status: **plan only, awaiting review.** Consultation decisions from
2026-10-16 are applied (see Decisions). Nothing in this plan authorizes an AWS
mutation. Every live run in §6.4 needs its own operator approval when it runs.

Issue: #100. Parent epic:
movie-reservation-platform-lab/movie-platform-environments#140 (walking
skeleton, milestone M0). The findings feed #103 (the per-component ECS
construct) and #101 (Spike S2, CodePipeline V2 CloudFormation deploy).

## Summary

The delivery design in `movie-platform-environments` (private) chooses
CloudFormation as the owner of each component's ECS service and task
definition. The image digest is a stack parameter, the ECS-native canary
strategy shifts traffic, and deployment alarms stop the rollout. Its rollback
policy (decision D4) is that alarms stop the line and humans roll back. Nothing
rolls back automatically: not ECS, not CodePipeline, not CloudFormation.

That design rests on AWS behaviour nobody here has observed yet:

- An ECS deployment that fails because of an alarm also fails the
  CloudFormation update. By default, CloudFormation then rolls the stack back,
  which is an automatic rollback through the side door. The candidate fix,
  updating with rollback disabled, has never been tried.
- Nobody knows what ECS does with production traffic when an alarm fires
  mid-canary and ECS rollback is off. Traffic might freeze at the canary
  split, finish shifting, or move off the failed revision.
- The design assumes composite alarms work as ECS deployment alarms. The ECS
  and CloudFormation docs only say "alarm names".

This plan defines a time-boxed, disposable spike that answers those questions
with evidence. It adds a separate CDK application,
`apps/ecs-canary-alarm-spike`, modelled on `apps/security-lake-firehose-spike`.
The app has one Fargate service behind an ALB, configured for ECS-native
canary, plus a small alarm set. A sequence of 12 targeted live runs (and one
optional run) varies the three rollback mechanisms one at a time:

- CloudFormation stack rollback;
- ECS `deploymentAlarms.rollback`;
- the ECS deployment circuit breaker.

The spike ends with a recorded evidence report, concrete construct defaults
for #103, a deploy-mechanism recommendation for #101, and an evidence-backed
answer to the D4 question in §6.6.

## Goals

- Observe, with timestamps, what each rollback mechanism does to traffic,
  ECS deployment state, and CloudFormation stack state during an ECS-native
  canary driven by a CloudFormation stack update.
- Answer the D4 question with evidence. When an alarm fires mid-canary, should
  ECS automatically abandon the in-flight deployment, or should the canary
  freeze until a human acts?
- Find out whether composite alarms work as ECS deployment alarms.
- Find out what ECS does when a deployment alarm is already in `ALARM` or
  `INSUFFICIENT_DATA` as a deployment starts.
- Measure time-to-halt for a deterministic forced alarm and time-to-detect for
  a real error-rate fault.
- Compare two recoveries from `UPDATE_FAILED`: `rollback-stack` versus
  redeploying the last-known-good digest as a parameter.
- Find out how long CloudFormation waits when the ECS deployment never
  stabilizes.
- Leave behind a reusable, tested spike app and a runbook that another operator
  could repeat.

## Non-goals

- Building the reusable per-component construct (#103).
- Changing `lib/infra-stack.ts`, the workload stack, or any existing app.
- Any IAM change outside the spike app's own stacks.
- Any deployment in this PR. This PR adds only the plan.
- Testing CodePipeline itself (parallel actions, stage conditions, event
  shapes). That is #101. This spike only records which deploy primitive the
  pipeline must call.
- Service Connect traffic shifting. AWS documents support for it, and live
  verification moves to #103's first split PR, where service-to-service calls
  exist (see Decisions).
- Lifecycle hooks, test listeners, linear and blue/green strategies. They use
  the same mechanism with different step shapes (Option G).
- Polished dashboards or production-grade alarms.

## Current State

### Delivery design (private repository, summarized)

- **§5.2 design choices.** Each component has its own CloudFormation stack.
  The template is synthesized once and promoted unchanged; the image digest is
  a parameter. CloudFormation owns the ECS service and task definition. The
  CodePipeline ECS standard action is rejected because it registers task
  definitions outside CloudFormation and causes drift. The design expects the
  deploy to run with rollback disabled. That leaves the stack in
  `UPDATE_FAILED` until a human runs `rollback-stack` or deploys a fix. It also
  asks S1 whether the CodePipeline CloudFormation action can do this, or
  whether the deploy has to run in CodeBuild.
- **§6.1 rollback alarm hierarchy.** An `environment-health` composite sits
  over one `{component}-rollback` composite per component. Each component
  composite is `anyOf` over the 5xx rate, p99 latency, unhealthy targets or
  task restarts, synthetic-journey failures, and team alarms. The component
  composite is meant to be the ECS deployment alarm. The rules are: count only
  the component's own errors, measure per revision, treat missing data
  explicitly per metric, and prefer precision over coverage. Composite support
  is listed as unverified, and the fallback is to list the member alarms
  directly.
- **§9 rollback policy.** In flight, deployment alarms with rollback disabled
  halt the rollout and a human decides what to do next. §9 leaves an open
  question for S1: does halting leave about 10% of traffic on the bad revision
  until a human acts? If it does, a paging SLO matters.
- **D4.** No automatic rollback anywhere: not ECS, not CodePipeline `ROLLBACK`,
  and not CloudFormation's own update rollback. The reason is that rollback is
  not always safe when data and code changes are coupled.
- **D5.** One ECS service per component, with Service Connect. S1 was asked to
  check Service Connect support for native canary and the proxy's overhead.
- **D8.** A CodeBuild watcher runs alongside the deploy. It halts ECS through a
  `watch-verdict` bridge alarm and publishes a heartbeat that treats missing
  data as breaching. S1 was asked to check end-to-end halt latency, including
  high-resolution alarms, and ECS halt behaviour with rollback disabled.
- **§13 Phase 0, S1.** Exit evidence is recorded timings, CloudFormation
  events, and a final read-back of the running digest.
- **§15 failure modes** that are relevant here:
  - a false-positive halt;
  - a blind alarm (no traffic);
  - halting a victim of someone else's failure;
  - an interruption mid-deploy that leaves the outcome unknown.

### This repository

- `apps/security-lake-firehose-spike` is the precedent for a disposable
  spike:
  - it is a separate npm workspace with its own `cdk.json`, `bin/`, `lib/`,
    `test/`, and Jest config;
  - `build`, `test`, and `synth` run without credentials;
  - synth runs `--no-lookups` against committed fixtures;
  - its README sets the safety boundary;
  - a runbook lives in `docs/operations/`;
  - sanitized evidence lives in `docs/plans/evidence/`.
- `apps/README.md`: apps may depend on `packages/*` only, and guarded live
  sequencing belongs in automation. `scripts/workspace-boundaries.ts` enforces
  this.
- Ingress convention: a customer-managed prefix list passed as the
  `allowedIngressPrefixListId` context value
  (`lib/config/platform-config.ts`, `docs/operations/aws-cdk-deployment.md`).
- Account and Region gate: `npm run preflight:aws` validates the
  `movie-platform-demo` SSO profile, `eu-central-1`, the account, and the role
  before every group of mutations.
- `cdk.json` sets `@aws-cdk/aws-ecs:removeDefaultDeploymentAlarm` and
  `@aws-cdk/aws-ec2:restrictDefaultSecurityGroup`. The second flag adds a
  custom-resource Lambda asset to any new VPC.

### Installed CDK (verified in `node_modules`, aws-cdk-lib 2.263.0, CLI 2.1135.0)

- `FargateServiceProps` accepts the deployment props this spike needs:
  - `deploymentStrategy: DeploymentStrategy.CANARY`;
  - `canaryConfiguration: { stepPercent, stepBakeTime }`, which synthesizes
    `CanaryConfiguration.CanaryPercent` and `CanaryBakeTimeInMinutes`;
  - `bakeTime`, which synthesizes `BakeTimeInMinutes`;
  - `deploymentAlarms`;
  - `circuitBreaker`;
  - `lifecycleHooks`.
- `deploymentAlarms.behavior` maps to CloudFormation `Rollback`:
  `ROLLBACK_ON_ALARM` gives `true` and `FAIL_ON_ALARM` gives `false`. The
  JSDoc for `ROLLBACK_ON_ALARM` says the stack "will be rolled back and enter
  state UPDATE_ROLLBACK_COMPLETE". This spike tests that claim.
- If `circuitBreaker` is set, CDK writes `rollback: false` unless the code
  asks for `true`.
- Canary needs a load-balancer target with an `alternateTarget`:
  `new ecs.AlternateTarget(id, { alternateTargetGroup, productionListener:
  ecs.ListenerRuleConfiguration.applicationListenerRule(rule) })`.
  - The production listener must be an `ApplicationListenerRule`, not the
    listener's default action.
  - Unless a role is passed in, CDK creates an ECS infrastructure role trusted
    by `ecs.amazonaws.com` with the AWS managed policy
    `AmazonECSInfrastructureRolePolicyForLoadBalancers`. ECS uses this role to
    rewrite listener-rule weights.
- `cdk deploy` supports `--no-rollback` and `--parameters`.

### AWS behaviour already documented (verified 2026-10-16)

- **Alarm already in ALARM at deployment start.** "If an alarm is in the
  `ALARM` state at the beginning of a deployment, Amazon ECS will not monitor
  alarms for the duration of that deployment." Source:
  [ECS deployment alarms](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-alarm-failure.html).
  This matters directly for D8's heartbeat alarm, which treats missing data as
  breaching. If the watcher has not published a heartbeat before the
  deployment starts, the heartbeat alarm is already in `ALARM`, and ECS would
  stop watching every alarm, not only the heartbeat. Run R6a tests this.
- **What a failed deployment does.** A deployment in `FAILED` state "won't
  launch any new tasks". With both the circuit breaker and alarms enabled,
  either one can fail the deployment, and a rollback follows only if the
  mechanism that failed it has rollback enabled. ECS polls alarms with
  `DescribeAlarms`, which counts against the CloudWatch API quota. Same
  source.
- **Canary mechanics.** Canary uses two target groups and a production
  listener rule with weighted forwarding. Default bake time is 15 minutes for
  canary, linear, and blue/green. Each lifecycle stage times out after
  24 hours, and the timeout itself triggers a rollback. CloudFormation allows
  36 hours for the whole deployment, then "fails the deployment, and then
  initiates a rollback". Sources:
  [canary deployments](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/canary-deployment.html),
  [ALB resources](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/alb-resources-for-blue-green.html),
  [CloudFormation `DeploymentConfiguration`](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-ecs-service-deploymentconfiguration.html).
- **Manual stop.** `StopServiceDeployment` with `--stop-type ROLLBACK` works
  "even if you didn't configure the service deployment for the rollback
  option", from `PENDING` or `IN_PROGRESS`. This is the human-triggered
  in-flight revert. Source:
  [stopping deployments](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/stop-service-deployment.html).
- **Pause hooks.** A pause hook holds a deployment until someone calls
  `ContinueServiceDeployment`, for up to 14 days. That is a gate, not an
  alarm reaction, so it is listed as an alternative in §6.6 and not tested.
- **CodePipeline CloudFormation action.** The documented configuration covers
  `ActionMode`, `StackName`, `Capabilities`, `ChangeSetName`, `RoleArn`,
  `TemplatePath`, `OutputFileName`, `ParameterOverrides`, and
  `TemplateConfiguration`. It has **no documented option to disable
  rollback**. Source:
  [action reference](https://docs.aws.amazon.com/codepipeline/latest/userguide/action-reference-CloudFormation.html).
  This is a hypothesis for #101 to confirm, not a conclusion.
- **Service Connect** supports ECS-native blue/green, linear, and canary
  traffic shifting. Test traffic is routed with headers. Source:
  [Service Connect resources](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-connect-blue-green.html).
  The proxy's overhead is not documented there.
- **Composite alarms are not documented either way.** One mechanistic reason
  for doubt: CloudWatch `DescribeAlarms` returns only metric alarms unless the
  caller asks for `AlarmTypes=CompositeAlarm`. Whether ECS asks for it is
  unknown.

## Proposed Design

### 1. Hypotheses

| ID | Hypothesis | Run(s) | Why it matters |
|---|---|---|---|
| H1 | With ECS alarm rollback **off** and CloudFormation rollback **disabled**, an alarm mid-canary marks the ECS deployment `FAILED`. No traffic shift follows. The canary split (about 10/90) **stays in place**. The stack ends `UPDATE_FAILED`. | R2 | If true, "freeze" leaves real users on the bad revision until a human acts (§9 open question). |
| H2 | An alarm during the post-shift bake (100% green, blue still running) with rollback off leaves 100% of traffic on green. | R3 | Decides whether "freeze" is acceptable after the shift completes. |
| H3 | With ECS alarm rollback **on**, ECS restores the production listener rule to 100% blue, which is still running, and scales green down. CloudFormation with rollback disabled ends `UPDATE_FAILED`, and its template still names the bad digest. That is drift between the template and the running revision. | R4 | Auto-abandon may be safe and fast but leave reconciliation work. |
| H4 | With CloudFormation rollback **enabled**, an alarm-failed ECS update triggers `UPDATE_ROLLBACK_IN_PROGRESS`. CloudFormation restores the previous task definition, which starts a **second** ECS deployment. If the alarm is still in `ALARM`, ECS does not monitor that second deployment. | R5a | This is the side-door rollback D4 forbids. |
| H5 | With ECS alarm rollback **on** and CloudFormation rollback **enabled**, the CloudFormation rollback lands on the revision ECS already restored. Little or no new traffic shift happens. | R5b | If true, the CodePipeline CloudFormation action may be acceptable even without a disable-rollback option. This decides #101. |
| H6 | Composite alarms are accepted in `DeploymentAlarms.AlarmNames`, and ECS monitors them. | R0, R4 | §6.1 builds the whole hierarchy on composites. |
| H7 | A deployment alarm already in `ALARM` at deployment start disables all alarm monitoring for that deployment. | R6a | D8's heartbeat alarm could silently disable every rollback signal. |
| H8 | An alarm in `INSUFFICIENT_DATA` at deployment start does not disable monitoring, and it halts the deployment if it later moves to `ALARM`. | R6b | §6.1 treats `INSUFFICIENT_DATA` as an error in blocking evaluations. ECS may treat it differently. |
| H9 | A task crash during canary (tasks never become healthy) is caught by the circuit breaker before any production traffic shift. 5xx alarms never fire, because green receives no traffic. Without the circuit breaker, CloudFormation waits until the ECS stage timeout. | R8a, R8b | Shows whether #103 needs the circuit breaker or a task-health alarm as well as 5xx alarms. |
| H10 | Time-to-detect for a real 5xx fault is dominated by the 60-second ALB metric resolution and the alarm's evaluation periods. The time from alarm to ECS halt is under one minute. | R2, R7, R7b | Sets the paging SLO and the canary bake length. |
| H11 | After a freeze, a roll-forward (a new digest via `update-stack` from `UPDATE_FAILED`) is accepted and replaces the frozen deployment. Because the error alarm is still in `ALARM` at its start, ECS does **not** monitor alarms during the roll-forward. | R9 | Roll-forward is the human recovery path for completed releases and break-glass freezes. A fix that ships with no alarm safety net needs an explicit guard in #103/#101. |

### 2. Spike topology (`apps/ecs-canary-alarm-spike`)

The topology has two stacks. The repository stack is created first, so images
can be pushed before the service stack starts its first task.

**`EcsCanarySpikeImageRepositoryStack`**

- One private ECR repository with immutable tags, scan-on-push,
  `emptyOnDelete: true`, and `RemovalPolicy.DESTROY`.
- **Why:** the service stack takes the image as a digest parameter, exactly as
  #103 will. Fixture images must exist before the service stack's first
  deploy. A spike-owned repository keeps them out of the application ECR
  repositories and out of the shared CDK bootstrap asset repository.

**`EcsCanarySpikeServiceStack`**

| Resource | CDK construct | Why |
|---|---|---|
| VPC, 2 AZs, **public subnets only**, no NAT | `ec2.Vpc` with `natGateways: 0` and one public subnet group | ALBs need two AZs. Public subnets with public task IPs pull from ECR through the internet gateway. That avoids NAT (about $0.05/h) and interface endpoints (about $0.01/h each per AZ). Network shape does not affect deployment semantics, which is the thing under test. |
| ALB, internet-facing, HTTP:80 | `elbv2.ApplicationLoadBalancer` | The canary traffic shifter. HTTP only: no domain or certificate is needed, and ingress is restricted to the operator prefix list. |
| ALB security group | Ingress only from `allowedIngressPrefixListId` on 80 | Same convention as the workload stack. |
| Listener with default action fixed-response 404 | `listener.addAction` | ECS canary must point at a listener **rule**, not the default action. |
| Production listener rule, priority 10, `path-pattern /*`, forward to blue target group | `elbv2.ApplicationListenerRule` | ECS rewrites this rule's target-group weights during the shift. Reading its weights back is the authoritative traffic split. |
| Two target groups, `ip`, HTTP, health check `/healthz` (interval 10s, 2/2 thresholds, deregistration delay 10s) | `elbv2.ApplicationTargetGroup` × 2 | Blue and alternate. The short timers keep runs fast. |
| Cluster, Fargate service, `desiredCount: 1`, task 0.25 vCPU / 0.5 GB, `assignPublicIp: true` | `ecs.Cluster`, `ecs.FargateService` | ECS scales green to the full desired count and splits traffic by listener weight, so one task per revision is enough. |
| Deployment configuration | `deploymentStrategy: CANARY`, `canaryConfiguration: { stepPercent: 10, stepBakeTime: 5 min }`, `bakeTime: 5 min`, plus `deploymentAlarms` and `circuitBreaker` from the profile below | The shortest bake times that still leave room to inject faults. |
| Load-balancer binding | `service.loadBalancerTarget({ containerName, containerPort, alternateTarget: new ecs.AlternateTarget(...) })`, then `attachToApplicationTargetGroup(blue)` | This is how the installed CDK expresses ECS-native canary. |
| ECS infrastructure role | Created by `AlternateTarget` (managed policy `AmazonECSInfrastructureRolePolicyForLoadBalancers`) | Lets ECS edit listener rules. Its policy is captured in the evidence for #103's IAM review. |
| Task security group | Ingress only from the ALB security group on the container port | No direct internet ingress to tasks. |
| Execution role | CDK default, scoped to the spike repository and log group | Image pull and logs only. No task role, because the fixture calls no AWS APIs. |
| Log group, 1-day retention, `DESTROY` | `logs.LogGroup` | Container logs. |
| `ImageReference` parameter | `CfnParameter` with an `AllowedPattern` that requires `…@sha256:<64 hex>` | Mirrors the #103 "digest as a parameter" contract. Fault runs change only this value. |
| **Error-rate alarm** (the service-level alarm) | `cloudwatch.Alarm` on metric math `100 * HTTPCode_Target_5XX_Count / RequestCount`, at the **load balancer** level, 60s period, 1 of 1 datapoints, threshold 2%, missing data `notBreaching` | Detects the real fault. It is LB-level because the two target groups swap roles on every deployment: a per-target-group alarm would watch the wrong group half the time. That is a finding #103 must design for. |
| **Watch-verdict bridge alarm** | `cloudwatch.Alarm` on custom metric `EcsCanarySpike/WatchVerdict`, **10s high-resolution** period, 1 of 1 datapoints, threshold ≥ 1. Missing-data treatment comes from context. | Models D8's bridge alarm. It is also a **sticky**, deterministic fault lever: the operator publishes `1` with `put-metric-data`. It is also the only way to hold an alarm in `ALARM` or `INSUFFICIENT_DATA` at deployment start (R6a/R6b). |
| **Rollback composite** | `cloudwatch.CompositeAlarm`, `anyOf(errorRate, watchVerdict)` | Models the `{component}-rollback` composite from §6.1. |
| ECS events to Logs | `events.Rule` on source `aws.ecs`, detail types `ECS Deployment State Change` and `ECS Service Action`, filtered to the spike cluster, targeting a 1-day log group | Gives ECS's own timestamps for deployment events (`SERVICE_DEPLOYMENT_IN_PROGRESS`, `_COMPLETED`, `_FAILED`, rollback). The CDK log-group target adds a small custom resource for the log resource policy. |
| Tags | `Project=movie-platform-infra`, `Spike=infra-100`, `Lifecycle=disposable`, `ExpiresOn=<date from context>` | Teardown verification uses the `Spike` tag. |

**The fixture image** lives in `apps/ecs-canary-alarm-spike/fixture-image/`. It
is a repository-owned image like `adot-collector/`, not application source:

- a stdlib-only Node HTTP server, with the base image pinned by digest;
- one build argument, `VARIANT`, with the values `good-1`, `good-2`,
  `bad-5xx`, and `crash`;
- every response carries an `x-spike-variant` header, so the probe can count
  the traffic split per revision from the client side;
- `bad-5xx` returns 200 on `/healthz` and 500 on everything else, so it
  passes health checks and only an alarm can catch it;
- `crash` exits 1 about 5 seconds after start, which exercises the circuit
  breaker.

The operator builds and pushes the four variants once. Each gets a distinct
digest, and the runbook records the digests privately.

### 3. Configuration boundary

App-local file `lib/spike-config.ts`. It reads CDK context as `unknown`,
validates it once, and returns a typed, readonly object. This follows the
repository rule of keeping untrusted context handling at one boundary.

```typescript
export type SpikeProfile = 'halt' | 'revert' | 'breaker';
export type BridgeMissingData = 'notBreaching' | 'breaching' | 'missing';
export type DeploymentAlarmSet = 'all' | 'members';

export interface EcsCanarySpikeConfig {
  readonly allowedIngressPrefixListId: string; // pl-…
  readonly profile: SpikeProfile;
  readonly bridgeMissingData: BridgeMissingData;
  readonly deploymentAlarmSet: DeploymentAlarmSet;
  readonly expiresOn: string; // YYYY-MM-DD
}
```

| `profile` | `deploymentAlarms.Rollback` | Circuit breaker |
|---|---|---|
| `halt` | `false` (`FAIL_ON_ALARM`) | absent |
| `revert` | `true` (`ROLLBACK_ON_ALARM`) | absent |
| `breaker` | `true` | `{ enable: true, rollback: false }` |

`deploymentAlarmSet`:

- `all`: `[errorRate, watchVerdict, composite]`;
- `members`: the composite is dropped, as the fallback if R0 shows composites
  are rejected.

The split between context and parameters is deliberate:

- **Template-shape toggles** (profile, alarm wiring) are CDK context. Changing
  them means a `cdk deploy` with a healthy, unchanged digest.
- **The digest** is a CloudFormation parameter. Fault runs use
  `aws cloudformation update-stack --use-previous-template --parameters …`,
  the same primitive a pipeline would call. This keeps "one variable per
  update" true for every faulted run.

### 4. Fault methods

1. **Forced alarm** (deterministic halt semantics):
   `aws cloudwatch set-alarm-state --alarm-name <name> --state-value ALARM
   --state-reason "spike R<n>"`.
   - A forced metric alarm returns to its computed state at the next
     evaluation, about 60s for the error-rate alarm. If ECS polls more slowly
     than that, the forced state can be missed.
   - The runbook therefore records whether the halt happened. If it did not,
     it repeats the run with the sticky lever: `put-metric-data` of
     `WatchVerdict=1` every 10s. The difference between the two runs is
     itself a finding about ECS's polling interval.
   - Composite alarms accept `set-alarm-state` as well. R4 forces the
     composite **directly** while its members stay `OK`. That isolates
     "ECS monitors composites" from "ECS monitors members".
2. **Real error-rate fault** (realistic time-to-detect): deploy the `bad-5xx`
   digest while the probe sends steady traffic (5 requests/s). At 10% canary
   that gives about 0.5 requests/s to green and an error rate of about 10%,
   well over the 2% threshold.

### 5. Observation instruments

Two read-only operator tools, plus AWS's own records:

- `scripts/ecs-canary-spike/probe.sh`:
  - sends `curl` requests to the ALB at a fixed rate;
  - writes one CSV row per request: `epoch_ms,http_status,x-spike-variant`;
  - `--summarize <csv>` prints the per-10s split and error rate, and the
    first and last time each variant was seen;
  - `--self-test` checks the summarizer against committed fixture CSVs.
- `scripts/ecs-canary-spike/observe.sh` polls every 10s and appends JSONL:
  - `ecs describe-services`: deployments, `rolloutState`, task definition,
    running counts;
  - `ecs list-service-deployments` and `describe-service-deployments`:
    status, lifecycle stage, rollback fields;
  - `elbv2 describe-rules` on the production rule: **target-group weights**;
  - `elbv2 describe-target-health` for both target groups;
  - `cloudformation describe-stacks` status and new `describe-stack-events`;
  - `cloudwatch describe-alarms` state for the three alarms;
  - `--self-test` validates its `jq` extraction against fixture JSON.
- AWS's own records: CloudWatch alarm history, the ECS events log group, and
  CloudFormation stack events.
- **Final read-back** after every run:
  - the service's primary task definition and its container image;
  - `ecs describe-tasks`, for the **runtime `imageDigest`** of each running
    task;
  - the stack's current `ImageReference` parameter.

  Comparing these three shows drift between the template and the running
  revision.

Timeline markers, all derived from those sources:

| Marker | Source |
|---|---|
| `T0` update-stack call | Runbook command timestamp |
| `T_green_healthy` | First healthy target in the alternate target group |
| `T_shift` | First non-100/0 rule weight |
| `T_fault` | `set-alarm-state` call, or the first 5xx with `x-spike-variant: bad-5xx` in the probe |
| `T_alarm` | Alarm history transition to `ALARM` |
| `T_halt` | ECS event `SERVICE_DEPLOYMENT_FAILED` or the start of a rollback |
| `T_traffic_restored` | Rule weights back to 100% blue, or the last green response in the probe |
| `T_cfn_terminal` | Final stack status event |

Derived durations:

- detect = `T_alarm − T_fault`;
- react = `T_halt − T_alarm`;
- restore = `T_traffic_restored − T_halt`;
- CloudFormation lag = `T_cfn_terminal − T_halt`;
- exposure = `T_traffic_restored − T_shift` for bad runs.

### 6. Experiment

#### 6.1 Mechanisms and coverage

| Mechanism | Values exercised | Not exercised, and why |
|---|---|---|
| CloudFormation stack rollback | enabled (R5a, R5b), `--disable-rollback` (all others) | — |
| ECS `deploymentAlarms.rollback` | `false` (R2, R3, R5a, R6a, R6b, R8b), `true` (R4, R5b, R7, R8a) | — |
| Circuit breaker | off (all except R8a), on with `rollback: false` (R8a) | Circuit breaker with `rollback: true`: AWS documents that only the initiating mechanism's rollback flag applies. R8a checks this indirectly, because alarm rollback is `true` and circuit-breaker rollback is `false` there. |

These combinations are deliberately skipped:

- **Circuit breaker × CloudFormation rollback enabled.** CloudFormation's
  reaction to a failed ECS deployment does not depend on which ECS mechanism
  failed it. R5a and R5b cover that reaction.
- **Circuit breaker × forced alarm.** A crash fault never reaches traffic, so
  alarms are irrelevant to it.
- **All eight combinations of the three booleans.** Most of them repeat the
  same transition. The matrix below changes one mechanism per run against a
  control.

#### 6.2 Run matrix

Each run starts from a stack in `UPDATE_COMPLETE` or `CREATE_COMPLETE`,
running a known-good digest, with all alarms `OK` (except in R6), and with the
probe and observer running. Reconfiguration steps (`cdk deploy`, healthy
digest unchanged) happen **before** the run and are recorded separately. The
first one also tells us whether changing only the deployment configuration
starts an ECS deployment.

"CFN" below is short for CloudFormation.

| Run | Profile / CFN mode | Change | Fault (when) | Questions answered | Recovery tested |
|---|---|---|---|---|---|
| R0 | `halt`, `all` / create | Create both stacks; push 4 variants; create with `good-1` | — | Composite accepted in `AlarmNames` at create? (H6 part 1) | — |
| R1 | `halt` / disable-rollback | `good-1 → good-2` | none (control) | Normal canary timeline, target-group swap, stack update duration, probe split per phase | — |
| R2 | `halt` / disable-rollback | `good-2 → good-1` | Forced error-rate `ALARM`, `T_shift + 2 min` (canary step) | H1, react latency (H10), stack status and lag, read-back | `rollback-stack` → time to restore |
| R3 | `halt` / disable-rollback | `good-x → good-y` | Forced error-rate `ALARM` during the deployment `BAKE_TIME` | H2, stack status, read-back | Redeploy the last-known-good digest (`update-stack` from `UPDATE_FAILED`) → time to restore |
| R4 | `revert`, `all` / disable-rollback | healthy digest change | Forced **composite** `ALARM` (members `OK`), canary step. If there is no halt within 3 min, force the error-rate alarm. | H6 part 2, H3, drift | Reconcile with `rollback-stack`. Does it start another ECS deployment? |
| R5a | `halt` / **rollback enabled** | healthy digest change | Forced error-rate `ALARM`, canary step | H4: side-door rollback, second deployment, monitored or not | Automatic (observed) |
| R5b | `revert` / **rollback enabled** | healthy digest change | Forced error-rate `ALARM`, canary step | H5: is CloudFormation's rollback benign after an ECS revert? Decides #101. | Automatic (observed) |
| R6a | `halt`, bridge `breaching` / disable-rollback | healthy digest change | Bridge already `ALARM` at `T0` (no data, treated as breaching). Then force error-rate `ALARM` at the canary step. | H7: are **all** alarms ignored? | Per R3 if halted; none needed if the deployment completed |
| R6b | `halt`, bridge `missing` / disable-rollback | healthy digest change | Bridge `INSUFFICIENT_DATA` at `T0`. At the canary step, publish `WatchVerdict=1` so the bridge moves to `ALARM`. | H8 | Per R3 |
| R7 | `revert` (chosen Option A; confirmed at the gate per §6.6) / disable-rollback | known-good digest → `bad-5xx` | Real 5xx, steady probe | H10: real detect, react, exposure for the chosen behaviour | Reconcile the stack (per R4's finding) |
| R7b (optional) | same as R7 | healthy digest change | `put-metric-data WatchVerdict=1` at the canary step | D8 end-to-end bridge latency with a 10s high-resolution alarm | Per profile |
| R8a | `breaker` / disable-rollback | → `crash` | Task crash loop | H9 part 1: circuit-breaker time to `FAILED`, stack status, no traffic shift | Redeploy the last-known-good digest |
| R8b | `halt` (no circuit breaker) / disable-rollback | → `crash` | Task crash loop, **time-boxed to 45 min** | H9 part 2: how long CloudFormation waits; the ECS lifecycle stage reached | `aws ecs stop-service-deployment --stop-type ROLLBACK`, then observe the stack. This is also the human-triggered in-flight revert for D4. |
| R9 | `halt` (break-glass freeze) / disable-rollback | known-good → `bad-5xx`, then roll forward to a new healthy digest | Real 5xx. The frozen canary keeps the error-rate alarm genuinely in `ALARM`. | H11: is a roll-forward from `UPDATE_FAILED` plus a `FAILED` ECS deployment accepted? What happens to the frozen green and blue? Are alarms monitored during the roll-forward (expected: no)? | The roll-forward is the recovery: measure time to restore |

Planned live time:

- Each faulted run plus its recovery takes about 25–35 minutes:
  scale-up 2–3 min, canary step 5 min, bake 5 min, and a recovery deployment
  that itself runs through canary.
- R8b is time-boxed to about 55 minutes.
- **Total: about 7–8 hours over two sessions.**
  - Session A: R0–R5b.
  - Session B: R6a–R9.
- The stack is torn down between sessions unless the sessions are on the same
  day.

#### 6.3 Per-run record (template for the evidence file)

For each run, the evidence file records:

- run ID;
- profile;
- CloudFormation mode;
- the before and after digest labels (never registry hosts or account IDs);
- `T0` and every marker from §5, as relative seconds;
- the probe split at `T_halt − 10s`, `T_halt`, `T_halt + 60s`, and
  `T_halt + 5 min`;
- rule weights at the same points;
- ECS deployment status and lifecycle stage sequence;
- whether a rollback was started and by whom;
- the stack status sequence, the terminal status, and the resource status
  reason of the failing resource (verbatim, with ARNs redacted);
- read-back: the template parameter's digest label, the task definition's
  image label, and the label of each running task's runtime digest;
- recovery: method, recovery deployment duration, and whether alarms were
  monitored during recovery;
- anomalies.

#### 6.4 Live-run safety gate

Every run, including R0 and teardown, is a separate approval. Before each run
the agent or operator posts this block and waits for an explicit "approved
R<n>":

```text
Run: R<n>   Profile: <…>   CFN mode: <…>
Account/Region: development workload account (movie-platform-demo), eu-central-1
Preflight: npm run preflight:aws -> <pass/fail>
Change: ImageReference <label-from> -> <label-to>   Fault: <method, timing>
Expected worst case: <e.g. 10% of probe traffic receives 5xx until T_halt>
Abort if: stack not terminal after <N> min, unexpected resource in change set,
          spend > budget, preflight fails
```

- No approval carries over to the next run.
- An approval for a run does not authorize teardown, a re-run, or a changed
  profile.

#### 6.5 Open questions answered by the runs

| Question | Answered by |
|---|---|
| Traffic split at the moment of halt | R2 (canary step), R3 (bake), R4/R5b (with revert) |
| Which task-definition revision serves traffic afterwards | Read-back on every run |
| ECS deployment state | Observer, plus the ECS events log |
| CloudFormation status and events | Observer, plus `describe-stack-events` |
| Time from fault to halt | R2 (forced), R7 (real), R7b (bridge) |
| How long CloudFormation waits if ECS never stabilizes | R8b (observed up to 45 min), plus the documented 24h stage and 36h CloudFormation limits |
| Are composite alarms accepted? | R0 (create-time validation), R4 (runtime monitoring) |
| Alarm in `ALARM` or `INSUFFICIENT_DATA` at start | R6a, R6b |
| `rollback-stack` versus redeploying the last-known-good digest | R2 vs R3 recovery: time to restore, extra ECS deployment, monitoring during recovery, final drift |
| Does roll-forward work after a freeze, and is it monitored? | R9 |
| Can the CodePipeline CloudFormation action be used? | R5b (is CloudFormation's own rollback benign?) plus the documented action options. Confirmed in #101. |

#### 6.6 The D4 question: abandon in flight automatically, or freeze?

There are three options:

- **Option F: freeze.** ECS alarm rollback is `false`. ECS marks the
  deployment `FAILED`, and traffic stays wherever it was when the alarm fired
  (H1/H2). A human chooses between `stop-service-deployment ROLLBACK`,
  rolling forward, or accepting.
- **Option A: abandon in flight automatically.** ECS alarm rollback is `true`,
  and CloudFormation rollback stays disabled. ECS returns production traffic
  to the blue revision, which is still running, and stops green. Humans own
  everything after a deployment reaches `COMPLETED`, plus reconciling the
  CloudFormation stack.
- **Option P: pause gate.** A pause lifecycle hook before the second traffic
  shift, combined with Option F. It turns every canary into a manual
  approval, which contradicts the hands-off workload lane (D1). It is
  documented only and not tested.

**Engineer direction (consultation, 2026-10-16): Option A, with a break-glass
freeze.**

- **In-flight canary:** ECS abandons it automatically. ECS alarm rollback is
  `true`, and CloudFormation rollback stays disabled.
- **Completed deployment:** nothing automatic. Humans decide, and the normal
  recovery is a roll-forward PR through the pipeline.
- **Break-glass:** a per-release opt-out that uses Option F (freeze) instead.
  It is expected to map to the design's planned `rollbackSafe: false` release
  flag, so a release that declares itself unsafe to abandon freezes instead.

The spike now **confirms** this direction rather than choosing it. The
argument for it:

- During a canary, the blue revision has never stopped. It is serving 90% or
  more of traffic, and it is the last revision that passed bake.
- Moving the remaining 10% back to blue is therefore not a rollback to old
  code against new data. It ends an experiment that was already mixed-version
  by design.
- D4's data-coupling concern applies to changes that have finished: contract
  migrations and formats already written. The design already keeps those out
  of the in-flight window, because migrations are a separate action (§9) and
  expand/contract arrives in Phase 2.
- Freezing keeps real users on a revision that is known to be bad, for as
  long as paging takes.

- Freezing cannot undo damage that green has already done. It only lets that
  damage keep growing until a human acts. Freezing is genuinely better only
  when users are pinned to green, for example by sticky sessions. Routing here
  is not sticky.

Option A narrows D4 to "no automatic rollback after a deployment completes;
ECS may abandon an in-flight canary; a release may opt into freeze". The
evidence PR proposes that amendment in `movie-platform-environments`, where it
is recorded.

The evidence confirms or overturns the direction as follows:

| Observation | Recommendation |
|---|---|
| R2: traffic stays at the canary split after `FAILED`, and R4: ECS restores 100% blue in under 1 min with CloudFormation `UPDATE_FAILED` | **Option A.** Freeze has real exposure, and abandon is fast and leaves only reconciliation work. |
| R2: ECS removes green from traffic even with rollback `false` | Option F is effectively Option A without green cleanup. Keep D4 unchanged and use Option F. |
| R4: ECS revert works but leaves the stack in a state that only a second canary deployment can reconcile | Option A, plus a construct note that reconciliation is a separate, monitored deployment |
| R5b: CloudFormation's own rollback after an ECS revert is a no-op or very fast | Option A also makes the CodePipeline CloudFormation action viable (#101) |
| R3: an alarm during the post-shift bake with rollback `false` leaves 100% on bad green | Option A matters even more. Blue is still running during bake, so abandoning remains "in flight". |

R7 runs with the `revert` profile, which is the chosen Option A. If R2–R5b
overturn the direction, the operator changes the profile at the R7 gate and
the evidence records why. R9 exercises the break-glass freeze path and the
roll-forward recovery it depends on.

#### 6.7 Recommendations this spike must produce

For **#103** (construct defaults), each with its evidence run:

- the strategy and its parameters: canary percent, canary bake, deployment
  bake;
- the `deploymentAlarms` value for `Rollback`, and whether the alarm list
  names the composite or its members;
- circuit-breaker settings;
- alarm metric scope: LB-level, metric math across both target groups, or
  per-revision application metrics. The reason is that the target groups
  alternate on every deployment;
- the alarm-state contract at deployment start: for example, the watcher
  publishes its first heartbeat **before** the deploy starts, or the heartbeat
  alarm is excluded from ECS's list and gated elsewhere, depending on R6a;
- a task-health or circuit-breaker signal for crash faults that 5xx alarms
  cannot see (R8);
- ECS infrastructure role scope;
- the stack update primitive and its disable-rollback flag;
- the expected deployment duration and CloudFormation timeout;
- a recovery runbook primitive: `rollback-stack` versus a last-known-good
  parameter redeploy.

For **#101** (deploy mechanism):

- whether the CodePipeline CloudFormation action is acceptable (R5b plus the
  documented options);
- otherwise, the exact CodeBuild command: `aws cloudformation deploy …
  --disable-rollback` or `update-stack … --disable-rollback`, and the stack
  status the action must treat as failure.

## Alternatives Considered

- **Option A: add canary to the existing workload stack (`lib/infra-stack.ts`).**
  Rejected. The workload is one shared task with six containers (D5's
  prerequisite has not landed). The issue keeps that stack out of scope, and
  any fault would hit every component at once.
- **Option B: AWS CLI scripts with no CDK app.** Faster to write, but with no
  synth or assertion tests. It also would not exercise the CDK
  `AlternateTarget` and `deploymentAlarms` APIs that #103 will use. Rejected.
- **Option C: every toggle as a CloudFormation parameter, applied with CDK
  escape hatches.** One template for all runs, but it bypasses the L2 API the
  construct will use (`behavior` is evaluated at synth time) and is harder to
  read. Rejected in favor of context profiles plus a digest parameter.
- **Option D: CDK `DockerImageAsset` for the fixture variants.** No separate
  repository stack, but the assets live in the shared bootstrap repository,
  are addressed by tag rather than digest, and outlive `cdk destroy`.
  Rejected.
- **Option E: private subnets with VPC endpoints, or NAT, like the workload
  stack.** More faithful networking, but it adds roughly $0.05–0.10/h and more
  resources without affecting deployment semantics. A missing endpoint would
  also make tasks fail to start, which looks exactly like a deployment failure
  and would confound R8a/R8b. Rejected for the spike. Whether the platform's
  private subnets use VPC endpoints only or a NAT gateway is a separate
  decision for the L2 substrate issue. The deciding question there is whether
  any service needs internet egress, for example an external LLM API.
- **Option F: CloudFormation `RollbackConfiguration` triggers (stack-level
  monitored alarms).** These are automatic stack rollbacks by design, which
  contradicts D4. Documented only.
- **Option G: a blue/green or linear strategy instead of canary.** Same
  mechanism and different step shapes. Canary is what #100 and §5.2 name.
  Results are expected to carry over and are noted as untested.

## Security And Operations

- **Account and Region.** The existing development workload account
  (`movie-platform-demo` SSO profile), `eu-central-1`.
  - Run `npm run preflight:aws` before each run group and before teardown.
  - Nothing depends on or touches the workload stack, and stack names are
    disjoint.
  - Check the VPC quota before R0 (default 5 per Region).
- **IAM.** IAM is created only inside the spike stacks:
  - the task execution role;
  - the ECS infrastructure role (AWS managed policy for load balancers);
  - the CDK default-security-group custom resource and the log-resource-policy
    custom resource roles.

  The evidence lists each role and its policy. No task role. Nothing changes
  in the bootstrap, OIDC, or admission roles.
- **Public exposure.**
  - The ALB is internet-facing on HTTP:80 and admits only the operator prefix
    list.
  - Tasks have public IPs but accept traffic only from the ALB security group.
  - No secrets, and the fixture returns static text.
- **Image provenance.**
  - Fixture images are built locally from committed source, with the base
    image pinned by digest.
  - They are pushed to the spike-owned repository with immutable tags and
    referenced by digest.
  - They are never pushed to application repositories.
- **Public-repository hygiene.**
  - Account IDs, ARNs, ALB DNS names, registry hosts, and raw JSONL stay in a
    private local evidence directory.
  - The committed evidence uses variant labels and relative times.
- **Tagging.** `Project`, `Spike=infra-100`, `Lifecycle=disposable`,
  `ExpiresOn`.
- **Cost estimate** (eu-central-1 list prices, unverified; verify before R0):

  | Item | Estimate |
  |---|---|
  | ALB | About $0.027/h, plus a negligible LCU charge |
  | Fargate, 0.25 vCPU / 0.5 GB | About $0.014/h per task; 1 task idle, 2 during runs |
  | Public IPv4 | $0.005/h each × 3–4 |
  | Alarms | Standard $0.10, high-resolution $0.30, composite $0.50 per alarm-month, prorated to cents |
  | Logs and ECR storage | Negligible |
  | **Total** | **About $0.10/h; about $1–2 for both sessions** |

  The proposed budget cap is $10. That covers a stack left up overnight by
  mistake.
- **Teardown** (its own approval). Run it after the last run, and also between
  sessions on different days:
  1. If an ECS deployment is still in progress, stop it:
     `aws ecs stop-service-deployment --stop-type ROLLBACK`.
  2. Delete the service stack:
     `npm run cdk --workspace @movie-platform/ecs-canary-alarm-spike -- destroy EcsCanarySpikeServiceStack --profile "$AWS_PROFILE"`.
     Deleting from `UPDATE_FAILED` is allowed.
  3. Delete the repository stack:
     `… destroy EcsCanarySpikeImageRepositoryStack`. The repository is
     emptied on delete.
  4. **Verify:**
     - `aws cloudformation describe-stacks` for both names returns "does not
       exist";
     - `aws resourcegroupstaggingapi get-resources --tag-filters
       Key=Spike,Values=infra-100` is empty (allow a few minutes for
       eventual consistency);
     - `aws ecs list-clusters`, `aws elbv2 describe-load-balancers`,
       `aws cloudwatch describe-alarms --alarm-name-prefix EcsCanarySpike`,
       `aws ecr describe-repositories`, and
       `aws logs describe-log-groups --log-group-name-prefix` show no spike
       resources;
     - the probe shows no listener.
  5. Deregister the spike task definitions if desired:
     `aws ecs delete-task-definitions`. `INACTIVE` revisions cost nothing.
  6. Record the verification output, redacted, in the evidence file.
- **Rollback of this spike.** It owns no shared state. Teardown is the
  rollback.

## Implementation Steps

This PR adds only this plan and a README index entry. The steps below are the
follow-up implementation PR, and then the separately approved live work.

The follow-up implementation runs in **hybrid teaching mode**. The proposed
ownership card is agreed before any code is written:

```text
Learning target: the ECS-native canary API in CDK, and what it synthesizes
                 (deploymentStrategy, canaryConfiguration, bakeTime,
                 deploymentAlarms, AlternateTarget + production listener rule)
AI owns:         steps 1–3 and 5–7 (workspace, config boundary, repository
                 stack, fixture image, probe/observer tools, runbook), the
                 non-canary parts of step 4 (VPC, ALB, target groups, alarms,
                 events rule), and the CDK assertion tests for step 4
Engineer owns:   in step 4, the Fargate service's deployment wiring: the
                 canary strategy and timings, deploymentAlarms per profile,
                 and the AlternateTarget binding to the two target groups and
                 the production listener rule. Plus a short teach-back mapping
                 it to the synthesized AWS::ECS::Service properties.
Done evidence:   the step 4 assertion tests pass for all three profiles;
                 `npm run synth:ecs-canary-alarm-spike` succeeds; the
                 engineer explains the synthesized DeploymentConfiguration
                 and LoadBalancers.AdvancedConfiguration
Support level:   guided (the engineer asks for hints when stuck)
```

The agent writes the step 4 assertion tests **before** the engineer's slice,
so the engineer works against failing tests that describe the expected
CloudFormation shape.

1. **Workspace skeleton.**
   - Change: create `apps/ecs-canary-alarm-spike` with `package.json`
     (`@movie-platform/ecs-canary-alarm-spike`), `cdk.json`, `tsconfig.json`,
     `jest.config.cjs`, and `README.md`, copying the Firehose spike's shape.
     Add it to the root `build:apps`, a new `test:cdk:ecs-canary-alarm-spike`,
     a new `synth:ecs-canary-alarm-spike` (fake account `111111111111`,
     `--no-lookups`, `-c allowedIngressPrefixListId=pl-0123456789abcdef0`),
     `ci`, and `.github/workflows/ci.yml`. List it in `apps/README.md`.
   - Verification: `npm run build:apps`, `npm run validate:workspace-boundaries`.
2. **Config boundary.**
   - Change: `lib/spike-config.ts` and `test/spike-config.test.ts`. Test valid
     profiles, invalid prefix list, unknown profile, missing `expiresOn`, and
     defaults.
   - Verification: `npm test --workspace @movie-platform/ecs-canary-alarm-spike`.
3. **Repository stack.**
   - Change: `lib/image-repository-stack.ts`, with assertions for immutable
     tags, scan-on-push, `EmptyOnDelete`, and the `Delete` policy.
4. **Service stack.**
   - Change: `lib/service-stack.ts` and `bin/ecs-canary-alarm-spike.ts`, per
     §2.
   - Test assertions:
     - `DeploymentConfiguration.Strategy = CANARY`, `CanaryConfiguration`, and
       `BakeTimeInMinutes = 5`;
     - `Alarms` (`Enable`, and `Rollback` per profile, using
       `Match.objectLike`);
     - circuit breaker absent or present per profile;
     - `LoadBalancers[0].AdvancedConfiguration` has
       `AlternateTargetGroupArn`, `ProductionListenerRule`, and `RoleArn`;
     - the infrastructure role trust and managed policy;
     - two `ip` target groups with `/healthz`;
     - a listener whose default action is fixed-response, plus a rule;
     - ALB security group ingress only from the prefix list, and task
       security group ingress only from the ALB security group;
     - no NAT gateway;
     - the `ImageReference` parameter `AllowedPattern` accepts a digest and
       rejects a tag (run the regex in the test);
     - error-rate metric math at LB level, the bridge alarm's 10s period and
       the `TreatMissingData` value from context, and the composite
       `AlarmRule` referencing both;
     - `AlarmNames` contents per `deploymentAlarmSet`;
     - the EventBridge rule pattern;
     - log retention and removal policies;
     - tags.

     Avoid asserting logical IDs.
5. **Fixture image.**
   - Change: `fixture-image/Dockerfile` (digest-pinned base, `VARIANT` build
     argument) and `fixture-image/server.mjs` with a pure `respond(variant,
     path)` function, plus a Jest test of that function per variant.
   - Verification: unit test. `docker build` once locally as a manual check;
     not in CI.
6. **Operator tools.**
   - Change: `scripts/ecs-canary-spike/probe.sh` and `observe.sh`, each with
     `--self-test` against fixtures in `test/fixtures/ecs-canary-spike/`. Add a
     root `validate:ecs-canary-spike-tools` script (`bash -n` plus the self
     tests) and add it to `ci`. Both tools are read-only toward AWS.
7. **Runbook.**
   - Change: `docs/operations/ecs-canary-deployment-alarm-spike.md`:
     - prerequisites and preflight;
     - image build and push with a private digest record;
     - R0–R8b, each with its gate block (§6.4), exact commands, expected
       observations, and abort criteria;
     - recovery procedures;
     - teardown and verification;
     - an evidence-capture checklist.

     Link it from `docs/operations/README.md`.
8. **Offline gate, then implementation PR review.**
   - Verification: `npm run ci` and a manual review of the synthesized
     template.
9. **Live sessions (each run separately approved).** Session A covers
   R0–R5b. Session B covers R6a–R9. Teardown is approved separately.
10. **Evidence PR.**
    - Change:
      - `docs/plans/evidence/ecs-canary-deployment-alarm-spike-<date>.md`,
        sanitized per §6.3;
      - an update to this plan's status;
      - a summary comment on #100;
      - recommendation comments on #103 and #101;
      - a proposed D4 amendment, if the evidence supports one, raised in
        `movie-platform-environments` for the engineer's decision.

## Testing Strategy

- **CDK assertions** (Jest + `aws-cdk-lib/assertions`) for both stacks across
  all three profiles and both alarm sets. Profiles are parameterized with
  `test.each`.
- **Config boundary unit tests**, covering runtime validation of `unknown`
  context. This is separate from compile-time types.
- **Offline synth contract**: `npm run synth:ecs-canary-alarm-spike` with
  `--no-lookups` in CI.
- **Fixture server unit test** for the per-variant response contract.
- **Shell tools**: `bash -n` plus `--self-test` against committed fixtures. No
  AWS calls in CI.
- **Workspace boundaries**: the existing validator and test cover the new app.
- **Live verification** is the experiment itself. The evidence must show
  teardown verification.

## Risks

| Risk | Impact | Likelihood | Mitigation |
|---|---:|---:|---|
| A forced metric alarm reverts before ECS polls, so there is no halt | A false "ECS ignored the alarm" | Medium | Note it and repeat with the sticky `WatchVerdict` lever (§4) |
| The installed CDK canary API differs from current AWS behaviour, for example a missing property | Stack fails to create | Low | R0 is a create-only run. Fall back to a `CfnService` property override and record it. |
| A stack gets stuck for hours (R8b, or an unexpected wait) | Cost and blocked session | Medium | 45-min time box, `stop-service-deployment`, documented 36h ceiling, teardown allowed from `UPDATE_FAILED` |
| A composite alarm is rejected at create | R0 fails | Medium | Redeploy with `deploymentAlarmSet=members`, which is itself the answer to H6 |
| ALB 60s metrics make the real-fault detect time noisy | Weak H10 evidence | Medium | R7b measures the high-resolution bridge path. Report ranges, not one number. |
| Private identifiers leak into the public evidence | Exposure | Low | Labels only, private raw directory, pre-commit grep for `arn:`, 12-digit numbers, and `amazonaws.com` |
| Spike results get generalized to Service Connect east-west canary | A wrong #103 default | Medium | Mark it untested; #103's first split PR verifies it |

## Decisions (consultation, 2026-10-16)

1. **D4 direction: Option A with a break-glass freeze** (§6.6). ECS abandons
   in-flight canaries, completed deployments are human-owned and rolled
   forward, and a release can opt into freeze. The spike confirms the
   direction, and the evidence PR proposes the D4 amendment in
   `movie-platform-environments`.
2. **Roll-forward is the primary human recovery.** Run R9 tests it after a
   freeze while the alarm is still firing.
3. **Network: public subnets for the spike only** (Option E). Endpoints versus
   NAT for the platform goes to the L2 substrate issue.
4. **Service Connect is deferred to #103.** There it is the engineer-owned,
   hybrid-teaching slice: namespace, registration, and client configuration.
   Canary behaviour over Service Connect is verified in the first split PR.
5. **Budget: $10 cap, two live sessions.** Each run is approved separately.
6. **Implementation in hybrid teaching mode.** The agent scaffolds, and the
   engineer owns the core service construct (see Implementation Steps).

## Done Criteria

- [ ] The implementation PR merges, with the spike app, tests, offline synth
      in CI, tools with self-tests, and the runbook.
- [ ] Every run in §6.2 (except optional R7b) is executed with its own
      approval, or explicitly skipped with a reason.
- [ ] The evidence file records, for each run: timings, the traffic split at
      halt, the ECS and CloudFormation state sequences, and the final digest
      read-back.
- [ ] H1–H11 are each marked confirmed, refuted, or inconclusive, with
      evidence.
- [ ] Teardown is verified and recorded. No `Spike=infra-100` resources
      remain.
- [ ] #100 has a summary comment. #103 and #101 have the §6.7
      recommendations.
- [ ] The D4 recommendation (§6.6) is raised in `movie-platform-environments`
      for decision.

## Handoff Prompt for Implementation Agent

```text
Implement steps 1–8 of docs/plans/ecs-canary-deployment-alarm-spike.md
(offline only; no AWS calls, no deploy) in hybrid teaching mode, using the
ownership card in Implementation Steps. Do not write the engineer-owned
deployment wiring in step 4; write its assertion tests first and stop for the
engineer's attempt.

Constraints:
- Stay inside apps/ecs-canary-alarm-spike, scripts/ecs-canary-spike,
  test/fixtures/ecs-canary-spike, docs/operations, apps/README.md, root
  package.json scripts, and .github/workflows/ci.yml.
- Do not touch lib/infra-stack.ts or any other app or package.
- No new npm dependencies; aws-cdk-lib and constructs only.
- Context is validated once in lib/spike-config.ts; the image is a
  CfnParameter with a digest-only AllowedPattern.
- Use the installed aws-cdk-lib ECS-native canary API
  (deploymentStrategy CANARY, canaryConfiguration, bakeTime,
  deploymentAlarms, AlternateTarget + ListenerRuleConfiguration).
- If the installed API cannot express something in the plan, stop and
  report instead of improvising.

Verification:
- npm run build:apps
- npm test --workspace @movie-platform/ecs-canary-alarm-spike
- npm run synth:ecs-canary-alarm-spike
- npm run validate:ecs-canary-spike-tools
- npm run validate:workspace-boundaries
- npm run ci
```
