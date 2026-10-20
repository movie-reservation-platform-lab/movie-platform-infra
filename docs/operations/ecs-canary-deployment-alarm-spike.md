# ECS Canary Deployment Alarm Spike Runbook

This runbook controls the disposable spike for issue #100 (S1). It observes
what ECS-native canary deployments, deployment alarms, the circuit breaker,
and CloudFormation stack rollback do when a release goes wrong.

Design, hypotheses, and the run matrix live in
[`docs/plans/ecs-canary-deployment-alarm-spike.md`](../plans/ecs-canary-deployment-alarm-spike.md).
This document is the operator procedure.

**Every live step is a separate approval.** That covers stack creation, each
run R0–R9 and R0b–R10, and teardown. Do not run a live block unless the operator has
approved that exact run ID in the current session. An approval never carries
over to a re-run, a changed profile, or teardown.

## Safety boundary

| Item | Value |
|---|---|
| Account | Development workload member account (`movie-platform-workload-development` SSO profile). Not the management account behind `movie-platform-demo`. |
| Region | `eu-central-1` |
| Stacks | `EcsCanarySpikeImageRepositoryStack`, `EcsCanarySpikeServiceStack` |
| Tags | `Spike=infra-100`, `Lifecycle=disposable`, `ExpiresOn=<date>` |
| Budget | $10 cap. About $0.10/h while the service stack exists. |
| Public exposure | ALB on HTTP:80, open only to the operator prefix list |
| Not touched | The workload stack, the bootstrap, OIDC, and admission roles |

Keep account IDs, ARNs, ALB DNS names, registry hosts, and raw observer
output in `.local/ecs-canary-spike/` (gitignored). Only sanitized results
with variant labels and relative times go into
`docs/plans/evidence/`.

## Offline gate

Run these from the repository root before every live session:

```bash
npm run build:apps
npm run test:cdk:ecs-canary-alarm-spike
npm run synth:ecs-canary-alarm-spike
npm run validate:ecs-canary-spike-tools
git diff --check
```

Review `cdk.out/ecs-canary-alarm-spike/EcsCanarySpikeServiceStack.template.json`.
The `AWS::ECS::Service` must have:

- `Strategy: CANARY`;
- `CanaryConfiguration` of 10% and 5 minutes;
- `BakeTimeInMinutes: 5`;
- `Alarms` with the expected `Rollback` value;
- `LoadBalancers[0].AdvancedConfiguration`.

## Session setup

The commands work in bash and zsh. Put the private values in a gitignored
file once:

```bash
mkdir -p .local/ecs-canary-spike
cat >.local/ecs-canary-spike/session.env <<'ENV'
export ALLOWED_INGRESS_PREFIX_LIST_ID='<pl-…>'   # existing operator prefix list
export SPIKE_EXPIRES_ON='<YYYY-MM-DD>'          # teardown deadline for the tag
ENV
```

Then, in **every** terminal you use for the spike (main, probe, observer),
from the repository root:

```bash
aws sso login --profile movie-platform-workload-development   # once per session
source scripts/ecs-canary-spike/session.sh
npm run preflight:aws
spike_status
```

`scripts/ecs-canary-spike/session.sh` sets the profile, the Region,
`AWS_PAGER=''`, the preflight target file
(`MOVIE_PLATFORM_AWS_TARGET_FILE`), the stack names, `EVIDENCE_DIR` (one
folder per day under `.local/ecs-canary-spike/`), and the digests from the
latest `digests.env`. It defines these helpers:

| Helper | Does |
|---|---|
| `marker "text"` | timestamped line in `$EVIDENCE_DIR/markers.txt` |
| `spike_cdk <args>` | CDK for the spike app with the required context |
| `stack_output <stack> <key>` | one CloudFormation output |
| `spike_update_digest <digest> enable` | change only the image digest (the pipeline primitive); validates its arguments and writes a marker |
| `spike_digest_label <digest>` | good-1, good-2, bad-5xx, or crash |
| `current_service_deployment` | newest ECS service deployment ARN |
| `spike_probe [R<n>]` | probe into `R<n>-probe.csv`; refuses to start without an ALB |
| `spike_observe [R<n>]` | observer into `R<n>-observer.jsonl` |
| `spike_status` | read-only stack, digest, running revision, and alarm summary |
| `spike_release <digest> <revert\|halt> [flags]` | Session 3: release an image through ECS (`release.sh`) |
| `spike_infra_deploy <diff\|deploy\|bootstrap> [flags]` | Session 3: infra deploy that carries the running revision (`infra-deploy.sh`) |

If you write your own commands in zsh, put braces around any variable that is
followed by `:` (`"${SERVICE_STACK}:ImageDigest=${DIGEST_GOOD_1}"`): zsh reads
`$var:x` as a modifier. Do not paste `bash` as the first line of a
multi-line block: the new shell swallows the rest of the paste.

The preflight must pass before every group of mutations, and it must report
the workload-development account. If it validates against the management
account, stop: `MOVIE_PLATFORM_AWS_TARGET_FILE` is not set in this terminal.

The spike deploys with CDK, so the account needs a CDK bootstrap in
`eu-central-1`. Check it read-only; if it is missing, stop and ask, because
bootstrapping is outside the spike's approval:

```bash
aws cloudformation describe-stacks --stack-name CDKToolkit \
  --query 'Stacks[0].StackStatus' --output text
```

Managed prefix lists belong to one account. Confirm the operator prefix
list exists in this account and contains your current IP:

```bash
aws ec2 get-managed-prefix-list-entries \
  --prefix-list-id "$ALLOWED_INGRESS_PREFIX_LIST_ID" --output table
curl -s https://checkip.amazonaws.com
```

Also check that the VPC quota leaves room for one more VPC (the default is
5 per Region):

```bash
aws ec2 describe-vpcs --query 'length(Vpcs)'
```

`update-stack` reuses the CloudFormation execution role that CDK attached
when it created the stack. Your SSO role needs `iam:PassRole` for that role,
which the operator permission set already grants for CDK deployments.

## R0: create the stacks and push the fixture variants

Approval block:

```text
Run: R0   Profile: halt, deploymentAlarmSet=all   CFN mode: create
Account/Region: development workload account, eu-central-1
Preflight: <pass>
Change: create EcsCanarySpikeImageRepositoryStack, push 4 images,
        create EcsCanarySpikeServiceStack with good-1
Expected worst case: service stack create fails (composite rejected); delete and retry with members
Abort if: preflight fails, cdk diff shows resources outside the two spike stacks
```

1. Create the repository stack:

   ```bash
   spike_cdk diff "$REPOSITORY_STACK"
   spike_cdk deploy "$REPOSITORY_STACK"
   REPO_URI="$(stack_output "$REPOSITORY_STACK" RepositoryUri)"
   REPO_NAME="$(stack_output "$REPOSITORY_STACK" RepositoryName)"
   ```

2. Build and push the four variants. Fargate defaults to `X86_64`.
   `--provenance=false` keeps each push a single image manifest, so the
   recorded digest is exactly what ECS pulls.

   ```bash
   aws ecr get-login-password | docker login --username AWS --password-stdin "${REPO_URI%%/*}"
   for variant in good-1 good-2 bad-5xx crash; do
     docker buildx build --platform linux/amd64 --provenance=false --load \
       --build-arg VARIANT="$variant" -t "$REPO_URI:$variant" \
       apps/ecs-canary-alarm-spike/fixture-image
     docker push "$REPO_URI:$variant"
   done
   for variant in good-1 good-2 bad-5xx crash; do
     digest="$(aws ecr describe-images --repository-name "$REPO_NAME" \
       --image-ids imageTag="$variant" --query 'imageDetails[0].imageDigest' --output text)"
     printf 'DIGEST_%s=%s\n' "$(tr 'a-z-' 'A-Z_' <<<"$variant")" "$digest"
   done | tee "$EVIDENCE_DIR/digests.env"
   source "$EVIDENCE_DIR/digests.env"
   ```

3. Review and create the service stack:

   ```bash
   spike_cdk diff "$SERVICE_STACK" -c spikeProfile=halt
   spike_cdk deploy "$SERVICE_STACK" -c spikeProfile=halt \
     --parameters "${SERVICE_STACK}:ImageDigest=${DIGEST_GOOD_1}"
   ```

   **Observe:** does CloudFormation accept the composite alarm name in
   `DeploymentConfiguration.Alarms.AlarmNames` (H6, part 1)? If creation
   fails on the alarm list, record the exact `ResourceStatusReason`, destroy
   the service stack, and redeploy with `-c deploymentAlarmSet=members`.

4. Start the instruments in two extra terminals. Keep them running for the
   whole session.

   ```bash
   source scripts/ecs-canary-spike/session.sh
   spike_probe baseline       # terminal 2
   spike_observe baseline     # terminal 3
   ```

   The probe must show only `good-1` and status 200 before any run starts:

   ```bash
   scripts/ecs-canary-spike/probe.sh summarize "$EVIDENCE_DIR/baseline-probe.csv"
   jq -r .observedAt "$EVIDENCE_DIR/baseline-observer.jsonl"   # a line every 15-25 s
   ```

   For each run, restart both with the run ID (`spike_probe R<n>`,
   `spike_observe R<n>`), so every run has its own files. Move a wrong file
   aside with `mv`; do not delete it.

   The summary splits failures by origin: `target_5xx` (the app answered
   with an error, which the error-rate alarm counts), `elb_5xx` (the ALB
   generated it, which the alarm does not see), and `no_response` (usually
   the client's network).

## Common run procedure

Each run R1–R9 follows the same shape:

1. **Gate:** post the approval block from plan §6.4, filled in for this run,
   and wait for "approved R<n>".
2. **Preconditions:**
   - the stack is `CREATE_COMPLETE` or `UPDATE_COMPLETE`, unless the run
     says otherwise;
   - the alarms are `OK`, unless the run says otherwise;
   - the probe and observer are running;
   - the profile matches the run.
3. **Reconfigure if needed.** A profile or alarm-wiring change is a separate
   `cdk deploy` with the current, healthy digest and no fault. CDK keeps the
   previous `ImageDigest` value. Record whether this alone starts an ECS
   deployment (first time only).

   ```bash
   spike_cdk deploy "$SERVICE_STACK" -c spikeProfile=<profile> [-c bridgeMissingData=<value>]
   ```

4. Run `marker "R<n> start"`, then start the change with
   `spike_update_digest <digest> enable`.
5. **Inject the fault** at the time the run specifies. Use the observer's
   `serviceDeployments[0].lifecycleStage` and `ruleWeights` to find "canary
   step" (weights 90/10) and "deployment bake" (weights 0/100 with blue
   still healthy). Record a marker for every action.
6. Watch until the stack reaches a terminal status, or the run's time box
   expires.
7. **Read back** the result (see below), recover as the run specifies, then
   read back again.
8. Run `marker "R<n> end"`, and copy the ECS events log group for the run
   window:

   ```bash
   aws logs filter-log-events \
     --log-group-name "$(stack_output "$SERVICE_STACK" EcsEventsLogGroupName)" \
     --start-time <epoch-ms> >"$EVIDENCE_DIR/R<n>-ecs-events.json"
   aws cloudwatch describe-alarm-history --alarm-name EcsCanarySpike-ErrorRate \
     --start-date <iso> >"$EVIDENCE_DIR/R<n>-alarm-history.json"
   ```

### Fault commands

```bash
# Forced metric alarm (transient: re-evaluated within about 60 s)
marker "fault: force ErrorRate ALARM"
aws cloudwatch set-alarm-state --alarm-name EcsCanarySpike-ErrorRate \
  --state-value ALARM --state-reason "spike R<n> forced"

# Forced composite alarm (its members stay OK)
aws cloudwatch set-alarm-state --alarm-name EcsCanarySpike-Rollback \
  --state-value ALARM --state-reason "spike R<n> forced composite"

# Sticky bridge alarm: publish a high-resolution verdict every 10 s until stopped
marker "fault: WatchVerdict=1 loop"
while true; do
  aws cloudwatch put-metric-data --namespace EcsCanarySpike --metric-name WatchVerdict \
    --value 1 --storage-resolution 1
  sleep 10
done
```

If a forced metric alarm does **not** halt the deployment, record it, then
repeat the run with the sticky bridge loop. The difference tells us how
often ECS polls alarms.

### Read-back

```bash
cluster="$(stack_output "$SERVICE_STACK" ClusterName)"
service="$(stack_output "$SERVICE_STACK" ServiceName)"
task_definition="$(aws ecs describe-services --cluster "$cluster" --services "$service" \
  --query 'services[0].taskDefinition' --output text)"
aws ecs describe-task-definition --task-definition "$task_definition" \
  --query 'taskDefinition.containerDefinitions[0].image' --output text
aws ecs describe-tasks --cluster "$cluster" \
  --tasks $(aws ecs list-tasks --cluster "$cluster" --service-name "$service" --query 'taskArns' --output text) \
  --query 'tasks[].{taskDefinition: taskDefinitionArn, digest: containers[0].imageDigest, health: healthStatus}'
aws cloudformation describe-stacks --stack-name "$SERVICE_STACK" \
  --query "Stacks[0].{status: StackStatus, digest: Parameters[?ParameterKey=='ImageDigest'].ParameterValue | [0]}"
```

Map each digest to its label with `digests.env`. Three values must be
compared:

- the stack parameter;
- the task definition's image;
- each running task's runtime `imageDigest`.

Any mismatch is drift, and it is a finding.

### Recovery commands

```bash
# Ask CloudFormation to restore the last stable template and parameters
aws cloudformation rollback-stack --stack-name "$SERVICE_STACK"

# Roll forward or redeploy a known-good digest from UPDATE_FAILED
spike_update_digest "$DIGEST_GOOD_1" enable

# Human-triggered in-flight revert (works even when rollback is not configured)
aws ecs stop-service-deployment --service-deployment-arn "$(current_service_deployment)" \
  --stop-type ROLLBACK
```

## Runs

> **R1 finding (2026-10-17): CFN mode `disable` cannot run.** Every digest
> change replaces the task definition, and CloudFormation rejects
> replacement updates on a stack with `--disable-rollback`
> (`Replacement type updates not supported on stack with disable-rollback`).
> The update fails in seconds, before any ECS deployment. Rows with
> `disable` wait for a re-plan; R1 is rerun with `enable`, and R5a and R5b
> are runnable as written.

The digests alternate so that every update is a real change. "Known-good"
means whichever good variant currently serves traffic. The other good
variant is the next healthy change.

| Run | Profile / extra context | CFN mode | Change | Fault, and when | Recovery | Time box |
|---|---|---|---|---|---|---|
| R1 | `halt` | disable | good-1 → good-2 | none (control) | none | 30 min |
| R2 | `halt` | disable | → other good | Force `ErrorRate` at the canary step + 2 min | `rollback-stack` | 40 min |
| R3 | `halt` | disable | → other good | Force `ErrorRate` during the deployment bake | `spike_update_digest <known-good> disable` | 40 min |
| R4 | `revert` | disable | → other good | Force **composite** `Rollback` at the canary step. If there is no halt within 3 min, force `ErrorRate`. | `rollback-stack`; record whether it starts another ECS deployment | 40 min |
| R5a | `halt` | **enable** | → other good | Force `ErrorRate` at the canary step | Automatic (observe) | 45 min |
| R5b | `revert` | **enable** | → other good | Force `ErrorRate` at the canary step | Automatic (observe) | 45 min |
| R6a | `halt`, `bridgeMissingData=breaching` | disable | → other good | Bridge already `ALARM` at start (no data). At the canary step, force `ErrorRate`. | If halted: per R3. Otherwise none. | 40 min |
| R6b | `halt`, `bridgeMissingData=missing` | disable | → other good | Bridge `INSUFFICIENT_DATA` at start. At the canary step, start the sticky bridge loop. | Per R3 | 40 min |
| R7 | `revert` (confirm at the gate) | disable | known-good → `bad-5xx` | Real 5xx | Reconcile per the R4 finding | 40 min |
| R7b (optional) | same as R7 | disable | → other good | Sticky bridge loop at the canary step | Per profile | 40 min |
| R8a | `breaker` | disable | → `crash` | Task crash loop | `spike_update_digest <known-good> disable` | 40 min |
| R8b | `halt` | disable | → `crash` | Task crash loop, **45 min time box** | `stop-service-deployment ROLLBACK`, then observe the stack | 60 min |
| R9 | `halt` | disable | known-good → `bad-5xx`, wait for the freeze, then **roll forward** to the other good digest | Real 5xx keeps `ErrorRate` in `ALARM` | The roll-forward itself: are alarms monitored during it? | 60 min |

**R1 extra observation (listener-rule ownership).** After the control
deployment completes, record the live rule action and CloudFormation drift.
ECS rewrites the production rule's forward weights during each deployment,
so the template's "forward to blue" is expected to differ from the live
rule. The rule's drift status is a construct note for #103.

```bash
rule_arn="$(stack_output "$SERVICE_STACK" ProductionListenerRuleArn)"
aws elbv2 describe-rules --rule-arns "$rule_arn" --query 'Rules[0].Actions'
drift_id="$(aws cloudformation detect-stack-drift --stack-name "$SERVICE_STACK" \
  --query StackDriftDetectionId --output text)"
sleep 30
aws cloudformation describe-stack-drift-detection-status --stack-drift-detection-id "$drift_id"
aws cloudformation describe-stack-resource-drifts --stack-name "$SERVICE_STACK" \
  --stack-resource-drift-status-filters MODIFIED \
  --query 'StackResourceDrifts[].{resource: LogicalResourceId, differences: PropertyDifferences}'
```

After R6a and R6b, redeploy with `bridgeMissingData=notBreaching`. After R7,
R8a, R8b, and R9, confirm that the probe shows only the known-good variant
before the next run.

**Abort any run** when:

- the stack has not reached a terminal state within its time box (stop the
  ECS deployment first, then record);
- the preflight fails;
- a change set contains anything except the expected resources;
- spend approaches the cap.

## Session 3: releases through ECS ("pattern 2")

Plan §6.8 explains why. In short: from now on CloudFormation owns the
infrastructure and the *recipe* task definition, and releases go to ECS
directly. Two commands are the only mutating paths:

| Path | Command | What it does |
|---|---|---|
| Release | `spike_release <digest> <revert\|halt>` | render the recipe with the new digest, register it, `update-service` with alarm rollback on (`revert`) or off (`halt`) |
| Infra deploy | `spike_infra_deploy deploy` | sync the deployed template to the running revision, `cdk deploy` with `-c activeTaskDefinitionArn=<running>`, and, if the recipe changed, release the running digest with the new recipe |

Two protections keep an infra deploy from putting an older image back:

- **The running revision is required CDK context, not a parameter.** A raw
  `spike_cdk deploy` or `diff` of the service stack fails with "Missing
  context activeTaskDefinitionArn" before anything reaches AWS. (A
  CloudFormation parameter would not protect: `cdk deploy` silently reuses
  its previous, possibly stale, value.)
- **The sync phase protects rollbacks.** If releases happened since the last
  infra deploy, the deployed template still names an older revision, and a
  failed deploy would roll the service back to it. The wrapper first updates
  the stack with the deployed template and only the service's task
  definition changed to the running one. A later rollback then returns to the
  running revision.

Releases and infra deploys must not overlap (the wrapper reads the running
revision once, at the start): run both from one terminal, one at a time. Do
not use `spike_update_digest` in Session 3.

Both scripts write their own markers. `release.sh` refuses to start while a
deployment is in flight, or unless every alarm the service watches is `OK`
(the pre-release gate). `--skip-alarm-gate` is for R5c-2, R6a, and R6b only.
Try `--dry-run` first whenever you want to see what a release would do.

Infra context comes from variables, so every wrapper call repeats it:

| Variable | Default | Used by |
|---|---|---|
| `SPIKE_PROFILE` | `revert` | the template's default alarm behaviour |
| `SPIKE_BRIDGE_MISSING_DATA` | `notBreaching` | R6a (`breaching`), R6b (`missing`) |
| `SPIKE_INFRA_REVISION` | `1` | R5c-3 (a cluster tag: infra only) |
| `SPIKE_RECIPE_REVISION` | `1` | R5c-3 (a container environment value: recipe) |
| `SPIKE_FAIL_INFRA_DEPLOY` | `false` | R5c-4 (a resource that fails after the service update) |

Set them with `export` in the terminal that runs the wrapper, and keep them
until the session ends.

### R0b: bootstrap the Session 3 stack

The repository stack and `digests.env` from R0 are reused.

```bash
spike_status                                   # service stack: DOES NOT EXIST
spike_cdk diff "$SERVICE_STACK" -c spikeProfile=revert -c activeTaskDefinitionArn=bootstrap-recipe
spike_infra_deploy bootstrap --digest "$DIGEST_GOOD_1"
spike_status                                   # running: <family>:1 image good-1 steady=true
```

Then start the instruments (`spike_probe R5c`, `spike_observe R5c`) as in R0
step 4. The probe must show only `good-1`.

### R5c-1: halt, outside CloudFormation (H12)

```bash
marker "R5c-1 start"
spike_release "$DIGEST_GOOD_2" halt --dry-run   # check: only the image changes; alarms.rollback false
spike_release "$DIGEST_GOOD_2" halt
```

When the observer shows the canary step (both weights above 0,
`PRODUCTION_TRAFFIC_SHIFT`), start the sticky bridge loop from
[Fault commands](#fault-commands) in its own terminal, and **leave it
running**. Observe:

- the service deployment goes to `STOPPED`;
- the listener weights stay at the split (90/10) for 10 minutes;
- the stack stays in its previous complete state; no stack events.

### R5c-2: roll forward under an alarm (H13)

The bridge loop is still running, so `WatchVerdict` is `ALARM`.

```bash
marker "R5c-2 start"
spike_release "$DIGEST_GOOD_1" revert                    # expected: the gate refuses (record it)
spike_release "$DIGEST_GOOD_1" revert --skip-alarm-gate
```

Observe: is the release accepted? What does the deployment's `alarms.status`
say? Does it roll back at once, or do the weights converge on `good-1`?
Then stop the loop (Ctrl-C), wait for `WatchVerdict` to return to `OK`, and
check `spike_status` shows `steady=true`.

### R5c-3: infra deploys through the wrapper (H14)

First an infra-only change:

```bash
marker "R5c-3 tag change"
export SPIKE_INFRA_REVISION=tag-2
spike_infra_deploy diff        # expect: the cluster tag only
spike_infra_deploy deploy      # expect: "recipe unchanged ... no release"
spike_status                   # same running revision as before
```

Check that no new ECS service deployment started (`current_service_deployment`
is the same ARN as before the deploy).

Then a recipe change:

```bash
marker "R5c-3 recipe change"
export SPIKE_RECIPE_REVISION=env-2
spike_infra_deploy diff        # expect: TaskDefinition replaced; the service may show as modified
spike_infra_deploy deploy      # expect: "recipe changed ... releasing the running digest"
```

Observe: exactly one ECS deployment (the wrapper's release), with the running
digest and `SPIKE_RECIPE_REVISION=env-2`; and no ECS deployment started by
CloudFormation itself during the stack update.

### R5c-4: a failed infra deploy after releases (H16)

Precondition: the deployed template names an older **image** than the one
running. Right after R5c-3 the revision is older, but both revisions use the
same image because the recipe release preserved the running digest. First
release the other good digest and wait for `steady=true`; do not run another
infra deploy, because the template must stay stale. Then check it:

```bash
spike_release <other good digest> revert
spike_status
```

The running image must now differ from the revision named by the deployed
template:

```bash
spike_status    # note the running revision, e.g. <family>:5
aws cloudformation get-template --stack-name "$SERVICE_STACK" --query TemplateBody --output json \
  | jq -r '.Resources[] | select(.Type == "AWS::ECS::Service") | .Properties.TaskDefinition'
# expect an older revision with the other good image
```

**R5c-4a, without the sync phase (shows the hole):**

```bash
marker "R5c-4a start"
export SPIKE_FAIL_INFRA_DEPLOY=true
spike_infra_deploy deploy --no-sync
```

Expected: CloudFormation updates the service to the running revision (no
ECS deployment), the wait condition fails after 30 s, and the rollback sets
the service back to the older revision. Observe: does ECS start a deployment
to the **older image**? Record the probe variants and the stack events. Let
it finish (it is a normal canary), then roll forward:

```bash
export SPIKE_FAIL_INFRA_DEPLOY=false
spike_release <the digest that ran before R5c-4a> revert
```

**R5c-4b, with the sync phase (shows the fix):** first make the template
stale again with one more release, then:

```bash
spike_release <other good digest> revert       # wait for SUCCESSFUL
marker "R5c-4b start"
export SPIKE_FAIL_INFRA_DEPLOY=true
spike_infra_deploy deploy                      # sync, then the failing deploy
export SPIKE_FAIL_INFRA_DEPLOY=false
```

Expected: the sync update completes with no ECS deployment; the second
update fails and rolls back; the service stays on the running revision and
no ECS deployment starts.

### R6a: an alarm already in ALARM at release start (H7)

```bash
marker "R6a setup"
export SPIKE_BRIDGE_MISSING_DATA=breaching
spike_infra_deploy deploy      # alarm change only; no release
# wait until WatchVerdict is ALARM (no data counts as breaching)
marker "R6a start"
spike_release <other good digest> revert --skip-alarm-gate
```

At the canary step, force `ErrorRate` ([Fault commands](#fault-commands)).
Observe: does ECS react to anything? Recovery:

```bash
export SPIKE_BRIDGE_MISSING_DATA=notBreaching
spike_infra_deploy deploy
```

### R6b: an alarm in INSUFFICIENT_DATA at release start (H8)

```bash
marker "R6b setup"
export SPIKE_BRIDGE_MISSING_DATA=missing
spike_infra_deploy deploy      # WatchVerdict goes to INSUFFICIENT_DATA
marker "R6b start"
spike_release <other good digest> revert --skip-alarm-gate
```

At the canary step, start the sticky bridge loop. Observe: does ECS halt and
revert? Stop the loop, then recover with
`export SPIKE_BRIDGE_MISSING_DATA=notBreaching` and `spike_infra_deploy deploy`.

### R10 (optional)

The lifecycle-hook run is not built yet (plan §6.8). Decide at the start of
the session whether to build it or move it to #103.

## Teardown (separate approval)

```text
Run: teardown   Account/Region: development workload account, eu-central-1
Change: delete EcsCanarySpikeServiceStack, then EcsCanarySpikeImageRepositoryStack
```

```bash
npm run preflight:aws
# 0. Session 3 only: note the task-definition family before the stack goes.
family="$(aws ecs describe-task-definition \
  --task-definition "$(stack_output "$SERVICE_STACK" RecipeTaskDefinitionArn)" \
  --query taskDefinition.family --output text)"
# 1. No deployment may be in progress; stop it if the observer shows one.
aws ecs stop-service-deployment --service-deployment-arn "$(current_service_deployment)" --stop-type ROLLBACK || true
# 2. Service stack first. Deleting from UPDATE_FAILED is allowed. Plain
#    CloudFormation: since Session 3 the service stack needs extra context to synth.
aws cloudformation delete-stack --stack-name "$SERVICE_STACK"
aws cloudformation wait stack-delete-complete --stack-name "$SERVICE_STACK"
# 3. Then the repository (emptied on delete).
spike_cdk destroy "$REPOSITORY_STACK" --force
```

The first service-stack delete can end in `DELETE_FAILED` on a target group
that is "in use by a listener or a rule". The template says the production
rule forwards to blue, but ECS rewrites it to forward to whichever group is
live, so CloudFormation may delete that group before the rule. Once the ALB
is gone, retry:

```bash
aws cloudformation delete-stack --stack-name "$SERVICE_STACK"
aws cloudformation wait stack-delete-complete --stack-name "$SERVICE_STACK"
```

Stop the probe and observer, then verify:

```bash
for stack in "$SERVICE_STACK" "$REPOSITORY_STACK"; do
  aws cloudformation describe-stacks --stack-name "$stack" 2>&1 | grep -q 'does not exist' \
    && echo "$stack deleted" || echo "$stack STILL PRESENT"
done
aws resourcegroupstaggingapi get-resources --tag-filters Key=Spike,Values=infra-100 \
  --query 'ResourceTagMappingList[].ResourceARN'
aws cloudwatch describe-alarms --alarm-name-prefix EcsCanarySpike \
  --alarm-types MetricAlarm CompositeAlarm --query '[MetricAlarms, CompositeAlarms][] | length(@)'
aws ecs list-clusters --query 'clusterArns' | grep -i spike || echo 'no spike cluster'
aws elbv2 describe-load-balancers --query 'LoadBalancers[].LoadBalancerName' | grep -i spike || echo 'no spike ALB'
aws ecr describe-repositories --query 'repositories[].repositoryName' | grep -i fixture || echo 'no fixture repository'
```

Session 3: `release.sh` registers revisions outside CloudFormation, so the
stack delete leaves them `ACTIVE`, tagged `Spike=infra-100`, and the tag check
above lists them. Deregister and delete them (free, but they fail the check):

```bash
for arn in $(aws ecs list-task-definitions --family-prefix "$family" --status ACTIVE \
    --query 'taskDefinitionArns[]' --output text); do
  aws ecs deregister-task-definition --task-definition "$arn" --query 'taskDefinition.revision'
done
for arn in $(aws ecs list-task-definitions --family-prefix "$family" --status INACTIVE \
    --query 'taskDefinitionArns[]' --output text); do
  aws ecs delete-task-definitions --task-definitions "$arn" --query 'failures'
done
```

Deregistered revisions otherwise remain `INACTIVE`, at no cost. Remove the
local images with `docker rmi`.

The tagging query may continue to return ECS control-plane records after the
live resources are gone. Confirm every returned task definition is
`DELETE_IN_PROGRESS` and every returned cluster or service is `INACTIVE`.
[AWS periodically purges task-definition records](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-definition-state.html):
deletion can take up to 24 hours after a service deployment or task set is
deleted. [Deleted clusters](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_DeleteCluster.html)
can remain discoverable as `INACTIVE` for an unspecified period. The strict
teardown boundary is therefore zero running or billable resources, zero active
task definitions, and only those terminal or deleting ECS records in the tag
result.

Record the redacted verification output in the evidence file.

## Evidence capture

For each run, the evidence file (plan §6.3) needs these sources from
`$EVIDENCE_DIR`:

- `markers.txt`;
- `probe.csv`, summarized with
  `scripts/ecs-canary-spike/probe.sh summarize "$EVIDENCE_DIR/probe.csv"`;
- `observer.jsonl`;
- `R<n>-ecs-events.json` and `R<n>-alarm-history.json`;
- the read-back output.

Before committing anything, grep the sanitized file for `arn:`,
`amazonaws.com`, `elb.amazonaws`, and 12-digit numbers.
