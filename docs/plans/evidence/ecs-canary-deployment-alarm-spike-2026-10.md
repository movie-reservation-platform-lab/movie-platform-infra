# ECS canary deployment alarm spike evidence (S1, #100)

Status: **partial.** The runs that decide D4 and most #103 defaults are done
(R0, R1, R5a, R5b, R7, R8a). R1 showed that the plan's "CloudFormation
rollback disabled" mode cannot run for image changes, so the runs built on it
(R2–R4, R6, R8b, R9) were not executed and wait for a re-plan. Recommendations
below are **proposed** and wait for the D4 discussion.

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
- Every image change is `update-stack --use-previous-template` with only the
  `ImageDigest` parameter changed: the primitive a pipeline would call.
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

### Reconfiguration and teardown

- Changing alarm behaviour or enabling the circuit breaker updates the service
  in place in about 40 s and starts **no** ECS deployment.
- Enabling the circuit breaker made CDK add `DeploymentController: ECS`.
  `cdk diff` reported "requires replacement"; CloudFormation updated in place.
- **Both** service-stack teardowns ended `DELETE_FAILED` on the target group
  that was live at the time: "in use by a listener or a rule". The template
  says the rule forwards to blue; ECS had rewritten it, so CloudFormation
  deleted the live group before the rule. A second `delete-stack` succeeded
  each time. No `Spike=infra-100` VPC, target group, or alarm remained.

## Hypotheses

| ID | Status | Evidence |
|---|---|---|
| H1 | **Not run as designed** (needs CFN rollback disabled). Partial: R5a shows traffic held at 90/10 after `STOPPED` until CloudFormation acted. | R1, R5a |
| H2 | Not run. | — |
| H3 | Not run as designed. Superseded by H5. | — |
| H4 | **Confirmed** (second deployment, a full canary). The "not monitored while the alarm is still `ALARM`" part is **inconclusive**: the forced alarm returned to `OK` 8 s after the rollback deployment started, and that deployment ended `MONITORING_COMPLETE`. | R5a, R8a |
| H5 | **Confirmed.** | R5b, R7 |
| H6 | **Confirmed** for acceptance and monitoring: the composite appears in `triggeredAlarmNames`. A composite-only trigger (R4) was not run. | R0, R5b, R7 |
| H7 | Not run. | — |
| H8 | Not run. | — |
| H9 | **Confirmed** for the circuit breaker (R8a). Without the breaker (R8b) not run. | R8a |
| H10 | **Confirmed.** Detection ≈172 s after the first error (metric lag), ECS reaction ≈25 s after `ALARM`. | R7 |
| H11 | Not run. The `--disable-rollback` roll-forward from `UPDATE_FAILED` is impossible for image changes (R1). | R1 |

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

## Proposed recommendations (pending the D4 discussion)

For **D4**: under CloudFormation-managed image deploys, `halt` gives neither a
lasting freeze nor a fast revert. The evidence supports **Option A with
`revert`**: ECS abandons an in-flight canary by flipping traffic back, and
CloudFormation stays consistent. A true "freeze, then roll forward" needs image
deploys that bypass CloudFormation (not tested: candidate run R5c).

For **#103** (construct defaults):

- deployment alarms with **rollback on**; the composite can be listed;
- **circuit breaker always on, with rollback on**;
- an error signal faster than a 1-minute ALB metric (for example the 10 s
  bridge alarm), or a smaller first canary step, to cut the ~3 min exposure;
- an **explicit `DeploymentController`** from the first deploy;
- the production listener rule depends on **both** target groups; its drift
  is expected and documented;
- deployment duration ≈ 15.5 min with 5/5 bakes; budget the pipeline timeout
  accordingly.

For **#101** (deploy mechanism): with `revert`, the CloudFormation rollback
after an ECS revert is a no-op, so a standard CloudFormation deploy action is
viable. `--disable-rollback` must not be used for image changes.

## Not run, and why

| Run | Reason |
|---|---|
| R2, R3, R4, R6a, R6b, R9 | Built on CloudFormation rollback disabled, which cannot run (R1). Need a re-plan. |
| R8b | Without the breaker, CloudFormation would wait for the ECS stage timeout (hours); R8a already shows the breaker is required. |
| R7b | Optional. |
| ECS infrastructure role policy capture | Not captured in these sessions; still needed for #103's IAM review. |
