# ECS canary deployment alarm spike evidence (S1, #100)

Status: **live runs and teardown complete.** Sessions 1–2 tested
CloudFormation-managed image releases. Session 3 tested the selected delivery
model: releases through ECS, with CloudFormation owning infrastructure and the
task-definition recipe. Optional lifecycle-hook run R10 moved to #103 because
its test listener, Lambda hook, verdict protocol, and smoke runner are separate
implementation work. ECS control-plane records from deleted resources remain
temporarily discoverable as `INACTIVE` or `DELETE_IN_PROGRESS`, as described
under teardown below.

Plan: [`../ecs-canary-deployment-alarm-spike.md`](../ecs-canary-deployment-alarm-spike.md).
Runbook: [`../../operations/ecs-canary-deployment-alarm-spike.md`](../../operations/ecs-canary-deployment-alarm-spike.md).

Do not add account IDs, ARNs, DNS names, registry hosts, or raw observer
output to this file. Times are relative to each run's start (`T0`) or to the
fault (`F`), in seconds, unless marked as a duration.

## Setup

- Development workload account, `eu-central-1`, public subnets, one task.
- ECS-native `CANARY` strategy: 10% step, 5 min canary bake, 5 min deployment
  bake. Alternate target with a production listener rule.
- Deployment alarms: LB-level 5xx error rate (1 min, threshold 2%), a 10 s
  bridge alarm, and a composite of both.
- Fixture images: `good-1`, `good-2`, `bad-5xx` (500 on `/`, healthy
  `/healthz`), `crash` (exits 5 s after start).
- Sessions 1–2 changed the `ImageDigest` CloudFormation parameter. Session 3
  rendered the CloudFormation-owned recipe with a new digest, registered it,
  and called ECS `update-service`. Infrastructure deploys passed the running
  task-definition revision back into CloudFormation through the wrapper.
- Instruments: a 5 req/s HTTP probe (the only traffic), and an observer
  polling ECS, ELB, CloudFormation, and CloudWatch every 10 s (one snapshot
  every 15–25 s in practice). AWS-side records (CloudFormation events, ECS
  service deployments, alarm history) are authoritative; the instruments add
  the client view and traffic weights.

Profiles: `halt` = deployment alarms with rollback off; `revert` = rollback
on; `breaker` = rollback on plus circuit breaker with rollback off.

## Run results

| Run | Profile / CFN rollback | Change | Fault | Outcome |
|---|---|---|---|---|
| R0 | `halt` | create with `good-1` | — | Stack created in ~6 min. Composite accepted in the deployment alarm list. |
| R1 | `halt` / **disabled** | `good-1` → `good-2` | — | **`UPDATE_FAILED` at T0+12:** `Replacement type updates not supported on stack with disable-rollback.` No ECS deployment. |
| R1-retry | `halt` / enabled | `good-1` → `good-2` | — | Clean canary. ECS `SUCCESSFUL` T0+765, stack `UPDATE_COMPLETE` T0+927. 0 errors. |
| R5a | `halt` / enabled | `good-2` → `good-1` | forced `ErrorRate` at canary | ECS `STOPPED` at F+10 with traffic held at 90/10. CloudFormation rolled back at F+72 with a full canary of the old revision. Stack terminal F+984. |
| R5b | `revert` / enabled | `good-1` → `good-2` | forced `ErrorRate` at canary | ECS rollback at F+29, traffic back by F+43, `ROLLBACK_SUCCESSFUL` F+70. CloudFormation rollback was a no-op. Stack terminal F+231. |
| R7 | `revert` / enabled | `good-1` → `bad-5xx` | real 5xx | Alarm 172 s after the first 500. ECS rollback 25 s later. 101 failed requests over 201 s. Stack terminal T0+495. |
| R8a | `breaker` / enabled | `good-1` → `crash` | crash loop | No traffic ever shifted. Breaker triggered at 3/3 failed tasks, T0+252. CloudFormation rolled back with a full canary of the old revision. Stack terminal ≈T0+1080. 0 errors. |
| R5c-1 | `halt`, ECS release | `good-1` → `good-2` | sticky bridge at canary | ECS `STOPPED` 24 s after the fault and held 90/10 for more than 10 min. CloudFormation stayed untouched. |
| R5c-2 | `revert`, ECS release | roll forward to `good-1` while alarms red | alarms already `ALARM` | Local gate refused; deliberate bypass was accepted. ECS completed with no triggered alarms while CloudWatch stayed red. |
| R5c-3 | infra wrapper | tag, then recipe environment | — | Tag change created no ECS deployment. Recipe change created exactly one wrapper-owned release of the running digest. |
| R5c-4a | infra wrapper, sync disabled | failing deploy while template named `good-1` and ECS ran `good-2` | 30 s wait condition | CloudFormation rollback started a full ECS canary of stale `good-1`; stack terminal after about 16 min. |
| R5c-4b | infra wrapper, sync enabled | same failing deploy | 30 s wait condition | Sync updated the rollback checkpoint without an ECS deployment. Failure rolled back in seconds; service stayed on `good-2` and no deployment started. |
| R6a | `revert`, ECS release | `good-2` → `good-1` | bridge already `ALARM`; force ErrorRate at canary | ECS ignored every alarm, completed, and recorded no triggered alarms. |
| R6b | `revert`, ECS release | `good-1` → `good-2` | bridge starts `INSUFFICIENT_DATA`, then sticky `ALARM` | ECS detected the transition and returned traffic to `good-1`; `ROLLBACK_SUCCESSFUL` about 102 s after the fault began. |

A first R5b attempt is void: the fault was injected after the deployment had
completed, and the finished deployment did not react (expected).

### R1-retry: clean canary (control)

| Time | Event |
|---|---|
| T0 | `update-stack` |
| +25 | ECS service deployment starts |
| +70 | New task healthy in the idle slot |
| +101 | Weights 90/10 (`PRODUCTION_TRAFFIC_SHIFT`) |
| +426 | Weights 0/100 |
| +457 | `BAKE_TIME` |
| +765 | ECS deployment `SUCCESSFUL` |
| +927 | Stack `UPDATE_COMPLETE` |

Read-back: stack parameter, task definition image, and running task digest all
`good-2`. The ErrorRate alarm stayed `OK`. The probe saw the client split move
from about 10% `good-2` to 100% with no failed request.

Listener rule after completion: forward to the live slot at weight 100, and
CloudFormation drift detection reports the production rule as `MODIFIED`
(`/Actions/0/TargetGroupArn` removed: ECS replaced the template's plain
forward with a weighted forward to both groups).

### R5a: `halt` under CloudFormation

| Time | Event |
|---|---|
| T0+96 | Weights 90/10 |
| F (T0+377) | `ErrorRate` forced to `ALARM` |
| F+10 | ECS deployment `STOPPED`: "Service deployment stopped because of one or more active alarms." Weights stay 90/10. |
| F+72 | Service `UPDATE_FAILED`: `Error occurred during operation 'ECS Deployment Alarm Detected'.` Stack `UPDATE_ROLLBACK_IN_PROGRESS`. |
| F+78 | CloudFormation's rollback starts a **new** ECS deployment of the previous task definition |
| F+92 | Weights 0/100 on the old revision's slot; last canary response at F+97 |
| F+172 | The rollback deployment runs its own canary (90/10) |
| F+833 | Rollback deployment `SUCCESSFUL` |
| F+984 | Stack `UPDATE_ROLLBACK_COMPLETE` |

Read-back: all `good-2` (the pre-run revision). The instruments have a gap from
about F+400 to F+2450 (operator laptop asleep); CloudFormation and ECS records
cover it.

### R5b: `revert` under CloudFormation

| Time | Event |
|---|---|
| T0+99 | Weights 90/10 |
| F (T0+184) | `ErrorRate` forced to `ALARM` |
| F+29 | ECS: "detected triggered alarm(s): rolling back to deploymentId …" |
| F+43 | Last canary response at the probe; weights back to 100% old |
| F+70 | ECS deployment `ROLLBACK_SUCCESSFUL` |
| F+187 | Service `UPDATE_FAILED` (`ECS Deployment Alarm Detected`); stack rolls back |
| F+190 to F+228 | CloudFormation updates the service back to the previous task definition: **no new ECS deployment** |
| F+231 | Stack `UPDATE_ROLLBACK_COMPLETE` |

Probe over the run: 67 responses from the canary revision, 0 5xx.

### R7: real 5xx with `revert`

| Time | Event |
|---|---|
| T0+93 | Weights 90/10 |
| T0+96 | First 500 at the probe |
| T0+268 | `ErrorRate` `ALARM` (the datapoint for the first canary minute: 9.9%) |
| T0+293 | ECS rollback; weights back to 100% old |
| T0+297 | Last 500 at the probe |
| T0+365 | `ROLLBACK_SUCCESSFUL` |
| T0+495 | Stack `UPDATE_ROLLBACK_COMPLETE` (CloudFormation rollback again a no-op) |

101 failed requests in a 201 s window at 10% of 5 req/s. The ALB metric showed
26, 37, 21, and 17 target 5xx per minute over those minutes.

### R8a: crash loop with the circuit breaker

| Time | Event |
|---|---|
| T0+26 | ECS deployment starts; breaker `MONITORING`, threshold 3 |
| T0+174 / +188 / +252 | Breaker 1/3, 2/3, 3/3 |
| T0+252 | ECS deployment `STOPPED`: "circuit breaker threshold was exceeded" |
| T0+287 | Stack `UPDATE_ROLLBACK_IN_PROGRESS`; a new ECS deployment of the old revision runs a full canary |
| T0+1006 | Rollback deployment `SUCCESSFUL` |
| ≈T0+1080 | Stack `UPDATE_ROLLBACK_COMPLETE` |

Weights stayed at 100% on the old revision throughout; 6,133 probe requests,
0 5xx. The ECS events log group held no events for this run (it did for R5b
and R7); the deployment records are complete.

### R5c-1 and R5c-2: freeze and roll forward outside CloudFormation

R5c-1 released through ECS with alarm rollback off. The canary reached 90/10
at 13:56:56Z. The sticky bridge alarm began at 13:56:47Z and ECS marked the
deployment `STOPPED` at 13:57:11Z. The listener stayed 90/10 through the
required ten-minute observation, and the stack stayed `CREATE_COMPLETE` with
no new events. This is the durable freeze that CloudFormation-managed image
updates could not provide.

R5c-2 kept the alarm red. The pre-release gate refused the roll-forward, then
the explicit test bypass started it. ECS accepted the release, shifted traffic
to `good-1`, and finished `SUCCESSFUL` at 14:22:47Z with
`MONITORING_COMPLETE` and no triggered alarm names, although the bridge and
composite stayed `ALARM`. The gate is therefore a safety boundary, not merely
operator convenience.

Across both windows the probe saw 6,076 responses: 5,635 `good-1`, 351
`good-2`, and 90 client-side timeouts. It saw no application or ALB 5xx.

### R5c-3: infrastructure and recipe ownership

The tag-only change first synchronized CloudFormation to the running revision,
then changed only the cluster tag. The newest ECS deployment ARN did not
change, the digest stayed `good-1`, and the wrapper reported "recipe unchanged;
no release."

Changing `SPIKE_RECIPE_REVISION` from `1` to `env-2` replaced the recipe task
definition. CloudFormation left the service on the running revision. The
wrapper then registered one revision with the running `good-1` digest and the
new recipe, and that release completed normally. No CloudFormation-owned ECS
deployment occurred.

### R5c-4: failed infrastructure deploy, without and with sync

The original R5c-4a precondition made the template and service revisions
different but left both on `good-1`. A preparatory `good-2` release made the
image regression observable: the deployed template named revision 11
(`good-1`), while ECS ran revision 14 (`good-2`).

Without sync, the deliberate wait condition failed at 17:02:16Z. Rollback
applied revision 11 and started a new ECS deployment at 17:02:29Z. Traffic
reached 90/10 at 17:03:36Z, moved fully to stale `good-1` by 17:09:04Z, and
the stack reached `UPDATE_ROLLBACK_COMPLETE` at 17:15:53Z. The probe window
contained 2,681 `good-2`, 2,085 `good-1`, 30 client-side timeouts, and no 5xx.

After rolling forward to revision 15/`good-2`, R5c-4b ran the same failure
with sync enabled. The sync phase changed the deployed template from revision
11 to 15 without an ECS deployment. The wait condition then failed, and the
stack rolled back in about three seconds to revision 15. The ECS deployment
ARN did not change; all 1,382 successful responses in the test window were
`good-2` (plus 15 client-side timeouts).

### R6a and R6b: alarm state at deployment start

For R6a, missing bridge data was treated as breaching. The bridge and
composite were `ALARM` before the release. At the 90/10 canary step,
`ErrorRate` was forced to `ALARM` for about 76 s. ECS neither halted nor
recorded any triggered alarm; it shifted fully to `good-1` and finished
`SUCCESSFUL`/`MONITORING_COMPLETE` while the original two alarms remained
red. A single alarm already in `ALARM` at start disables enforcement for the
whole deployment alarm set.

For R6b, the bridge was `INSUFFICIENT_DATA` and the composite was `OK` at
start. The sticky verdict began at the 90/10 step at 18:21:17Z. The bridge and
composite entered `ALARM` by 18:21:34Z; ECS began rollback at 18:21:48Z,
returned traffic fully to `good-1` by the next observer snapshot, and reached
`ROLLBACK_SUCCESSFUL` at 18:22:59Z. Starting from `INSUFFICIENT_DATA` does not
disable later enforcement.

Session 3 final read-back: the stack was `UPDATE_COMPLETE`, the service was
steady on revision 16, the task definition and running task both resolved to
`good-1`, the recipe environment was `env-2`, and all three alarms were `OK`.
The CloudFormation template also named revision 16, so no release drift
remained before teardown.

### Reconfiguration and teardown

- Changing alarm behaviour or enabling the circuit breaker updates the service
  in place in about 40 s and starts **no** ECS deployment.
- Enabling the circuit breaker made CDK add `DeploymentController: ECS`.
  `cdk diff` reported "requires replacement"; CloudFormation updated in place.
- **Both earlier** service-stack teardowns ended `DELETE_FAILED` on the target group
  that was live at the time: "in use by a listener or a rule". The template
  says the rule forwards to blue; ECS had rewritten it, so CloudFormation
  deleted the live group before the rule. A second `delete-stack` succeeded
  each time. No `Spike=infra-100` VPC, target group, or alarm remained.

The final Session 3 teardown began at 18:59Z. The first service-stack deletion
hit the same expected target-group ordering failure; the documented retry
succeeded. The service stack, repository stack, ECR repository, cluster, ALB,
and all alarms then read back as absent. All 17 task-definition revisions were
deregistered and accepted for deletion with no API failures.

After a ten-minute convergence wait, the Resource Groups Tagging API still
returned 21 ECS records: 17 task definitions in `DELETE_IN_PROGRESS`, three
deleted clusters in `INACTIVE`, and one deleted service record. Direct list
APIs returned zero active clusters and zero active or inactive task
definitions. This is ECS control-plane retention rather than live
infrastructure: AWS documents that task-definition deletion can take up to 24
hours after a service deployment is deleted, and that deleted clusters may
remain discoverable as `INACTIVE` for a period. There are no running or
billable spike resources left. The four local fixture-image tags were also
removed.

## Hypotheses

| ID | Status | Evidence |
|---|---|---|
| H1 | **Not run as designed** (needs CFN rollback disabled). Partial: R5a shows traffic held at 90/10 after `STOPPED` until CloudFormation acted. | R1, R5a |
| H2 | Not run. | — |
| H3 | Not run as designed. Superseded by H5. | — |
| H4 | **Confirmed** (second deployment, a full canary). The "not monitored while the alarm is still `ALARM`" part is **inconclusive**: the forced alarm returned to `OK` 8 s after the rollback deployment started, and that deployment ended `MONITORING_COMPLETE`. | R5a, R8a |
| H5 | **Confirmed.** | R5b, R7 |
| H6 | **Confirmed** for acceptance and monitoring: the composite appears in `triggeredAlarmNames`. A composite-only trigger (R4) was not run. | R0, R5b, R7 |
| H7 | **Confirmed.** The release completed while two alarms stayed red, and a third alarm transition during canary was ignored. | R6a |
| H8 | **Confirmed.** `INSUFFICIENT_DATA` at start did not disable enforcement; the later `ALARM` transition triggered rollback. | R6b |
| H9 | **Confirmed** for the circuit breaker (R8a). Without the breaker (R8b) not run. | R8a |
| H10 | **Confirmed.** Detection ≈172 s after the first error (metric lag), ECS reaction ≈25 s after `ALARM`. | R7 |
| H11 | Not run in its original CloudFormation form. **Its delivery-model question is confirmed by H13:** a roll-forward under an alarm is accepted and unmonitored. | R1, R5c-2 |
| H12 | **Confirmed.** ECS `halt` held the 90/10 split for more than ten minutes with no CloudFormation action. | R5c-1 |
| H13 | **Confirmed.** The gate refused; the bypassed roll-forward completed while its alarms stayed red and recorded no trigger. | R5c-2 |
| H14 | **Confirmed.** Infra-only change: no deployment. Recipe change: exactly one wrapper-owned release with the running digest. | R5c-3 |
| H15 | **Not run; moved to #103.** The lifecycle hook requires a test listener, Lambda hook, verdict protocol, and smoke runner. | R10 |
| H16 | **Confirmed.** No sync restored stale `good-1`; sync preserved `good-2` and created no ECS deployment. | R5c-4a, R5c-4b |

## Findings

1. **CloudFormation rejects `--disable-rollback` for every image change.** The
   task definition is replaced on each digest change, and replacement updates
   are not allowed with rollback disabled. "Freeze by not rolling back the
   stack" does not exist for CloudFormation-managed image deploys.
2. **ECS can freeze; CloudFormation will not let it stay frozen.** With
   `halt`, ECS stops within ~10 s and holds the canary split. About a minute
   later CloudFormation fails the service and rolls back.
3. **A CloudFormation-driven revert is a full canary of the old revision**
   (~13 min of deployment, ~16 min to a terminal stack), even when the old
   revision is already serving all traffic (R8a).
4. **ECS's own rollback is a traffic flip** to the still-running old tasks:
   under a minute, and the CloudFormation rollback that follows is a no-op.
5. **Real errors are detected ~3 min late.** The ALB metric and the 1-minute
   alarm dominate; ECS reacts within ~25 s of `ALARM`. Forced-alarm runs are
   optimistic by those ~3 minutes.
6. **Crashes never reach traffic,** so 5xx alarms are silent. Only the
   circuit breaker catches them (~4 min for 3 failed tasks).
7. **A clean release takes ~15.5 min** with 5/5 bakes; CloudFormation
   finishes ~2 min 40 s after ECS.
8. **The production listener rule is permanently drifted** after the first
   deployment, and its dependency on the live target group is invisible to
   CloudFormation, which breaks teardown ordering.
9. ALB weights are relative (100/900 = 10%/90%); EventBridge receives only
   coarse deployment events (start, failed, completed, steady state), so
   lifecycle stages must be polled.
10. Configuration-only changes do not redeploy tasks.
11. After a failed update with rollback disabled, the stack's `ImageDigest`
    parameter names the new digest while the old one runs (R1).
12. The fixture's Node default keep-alive (5 s) caused occasional ALB-generated
    502s, which the target-5xx alarm does not count (fixed in #114).
13. **A true canary freeze requires releases outside CloudFormation.** ECS
    holds the split indefinitely when `rollback=false`; the stack is not part
    of the release and cannot undo it.
14. **A roll-forward started under an existing alarm is unmonitored.** The
    pre-release all-alarms-`OK` gate is mandatory. Its bypass must be an
    explicit break-glass action.
15. **Infrastructure deploys need the running task-definition revision and a
    sync phase.** Without sync, a later CloudFormation rollback redeploys the
    stale image. With sync, the same failed update does not touch ECS.
16. **`ALARM` and `INSUFFICIENT_DATA` at release start are materially
    different.** `ALARM` disables the whole set; `INSUFFICIENT_DATA` still
    allows a later transition to trigger rollback.
17. The ECS alternate-target role has only
    `AmazonECSInfrastructureRolePolicyForLoadBalancers`. CDK failure
    diagnostics reported denied EC2 `DescribeInternetGateways`,
    `DescribeSubnets`, and `DescribeVpcs` calls for that role during R5c-4a;
    deployments still worked. Treat this as an IAM/diagnostic follow-up for
    #103, not as a reason to broaden the spike role without evidence.

## Recommendations after Session 3

For **D4**: use ECS releases outside CloudFormation. Default to `revert` for a
rollback-safe release; use `halt` only for a release explicitly marked unsafe
to roll back. `halt` is now a real freeze, and recovery is a new ECS release.
CloudFormation owns infrastructure and the task-definition recipe, while the
release path renders that recipe with an immutable image digest.

For **#103** (construct defaults):

- deployment alarms with **rollback on**; the composite can be listed;
- **circuit breaker always on, with rollback on**;
- an error signal faster than a 1-minute ALB metric (for example the 10 s
  bridge alarm), or a smaller first canary step, to cut the ~3 min exposure;
- an **explicit `DeploymentController`** from the first deploy;
- an all-alarms-`OK` pre-release gate; an existing `ALARM` disables all ECS
  alarm enforcement for that release, while `INSUFFICIENT_DATA` should block
  the gate even though ECS can monitor a later transition;
- one serialized delivery lane per service for releases and infrastructure
  deploys, with the infra wrapper synchronizing the running revision before
  any deploy;
- the production listener rule depends on **both** target groups; its drift
  is expected and documented;
- deployment duration ≈ 15.5 min with 5/5 bakes; budget the pipeline timeout
  accordingly.

For **#101** (deploy mechanism): separate ECS image releases from
CloudFormation infrastructure deploys. The release path is render → register
→ `update-service`. The infra path must carry and first synchronize the
running task-definition revision. `--disable-rollback` must not be used for
image changes.

## Not run, and why

| Run | Reason |
|---|---|
| R2, R3, R4, R9 | Built on CloudFormation rollback disabled, which cannot run (R1). Superseded by Session 3. |
| R8b | Without the breaker, CloudFormation would wait for the ECS stage timeout (hours); R8a already shows the breaker is required. |
| R7b | Optional. |
| R10 | Optional and not cheap: its lifecycle-hook test harness is implementation work for #103. |
