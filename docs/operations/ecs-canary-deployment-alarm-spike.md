# ECS Canary Deployment Alarm Spike Runbook

This runbook controls the disposable spike for issue #100 (S1). It observes
what ECS-native canary deployments, deployment alarms, the circuit breaker,
and CloudFormation stack rollback do when a release goes wrong.

Design, hypotheses, and the run matrix live in
[`docs/plans/ecs-canary-deployment-alarm-spike.md`](../plans/ecs-canary-deployment-alarm-spike.md).
This document is the operator procedure.

**Every live step is a separate approval.** That covers stack creation, each
run R0–R9, and teardown. Do not run a live block unless the operator has
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

```bash
aws sso login --profile movie-platform-workload-development
export AWS_PROFILE=movie-platform-workload-development
export AWS_REGION=eu-central-1
# The preflight defaults to the management-account target file. Point it at
# the private workload-development target instead.
export MOVIE_PLATFORM_AWS_TARGET_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/movie-platform/workload-development-aws-target.json"
export ALLOWED_INGRESS_PREFIX_LIST_ID='<pl-…>'   # existing operator prefix list
export SPIKE_EXPIRES_ON='<YYYY-MM-DD>'          # teardown deadline for the tag
export EVIDENCE_DIR="$PWD/.local/ecs-canary-spike/$(date +%F)"
mkdir -p "$EVIDENCE_DIR"
npm run preflight:aws
```

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

Define the helpers used below:

```bash
SERVICE_STACK=EcsCanarySpikeServiceStack
REPOSITORY_STACK=EcsCanarySpikeImageRepositoryStack

# CDK with the required context. Extra -c flags select the run profile.
spike_cdk() {
  npm run cdk --workspace @movie-platform/ecs-canary-alarm-spike -- "$@" \
    -c allowedIngressPrefixListId="$ALLOWED_INGRESS_PREFIX_LIST_ID" \
    -c expiresOn="$SPIKE_EXPIRES_ON"
}

stack_output() {
  aws cloudformation describe-stacks --stack-name "$1" --output text \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue | [0]"
}

# Change only the image digest, using the same template. This is the
# primitive a delivery pipeline would call. $2 is "disable" or "enable"
# (CloudFormation stack rollback).
spike_update_digest() {
  local rollback_flag=()
  [[ "$2" == disable ]] && rollback_flag=(--disable-rollback)
  date -u +%FT%T.%3NZ | tee -a "$EVIDENCE_DIR/markers.txt"
  aws cloudformation update-stack --stack-name "$SERVICE_STACK" \
    --use-previous-template --capabilities CAPABILITY_IAM \
    --parameters ParameterKey=ImageDigest,ParameterValue="$1" \
                 ParameterKey=BootstrapVersion,UsePreviousValue=true \
    "${rollback_flag[@]}"
}

# The service's current ECS service deployment ARN (newest first).
current_service_deployment() {
  aws ecs list-service-deployments \
    --cluster "$(stack_output "$SERVICE_STACK" ClusterName)" \
    --service "$(stack_output "$SERVICE_STACK" ServiceName)" \
    --max-results 1 --query 'serviceDeployments[0].serviceDeploymentArn' --output text
}

marker() { printf '%s %s\n' "$(date -u +%FT%T.%3NZ)" "$*" | tee -a "$EVIDENCE_DIR/markers.txt"; }
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
     --parameters "$SERVICE_STACK:ImageDigest=$DIGEST_GOOD_1"
   ```

   **Observe:** does CloudFormation accept the composite alarm name in
   `DeploymentConfiguration.Alarms.AlarmNames` (H6, part 1)? If creation
   fails on the alarm list, record the exact `ResourceStatusReason`, destroy
   the service stack, and redeploy with `-c deploymentAlarmSet=members`.

4. Start the instruments in two extra terminals. Keep them running for the
   whole session.

   ```bash
   scripts/ecs-canary-spike/probe.sh run \
     --url "http://$(stack_output "$SERVICE_STACK" LoadBalancerDnsName)/" \
     --out "$EVIDENCE_DIR/probe.csv" --rate 5
   scripts/ecs-canary-spike/observe.sh run --stack "$SERVICE_STACK" \
     --out "$EVIDENCE_DIR/observer.jsonl" --interval 10
   ```

   The probe must show only `good-1` and status 200 before any run starts.

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
   `spike_update_digest <digest> <disable|enable>`.
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
spike_update_digest "$DIGEST_GOOD_1" disable

# Human-triggered in-flight revert (works even when rollback is not configured)
aws ecs stop-service-deployment --service-deployment-arn "$(current_service_deployment)" \
  --stop-type ROLLBACK
```

## Runs

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

## Teardown (separate approval)

```text
Run: teardown   Account/Region: development workload account, eu-central-1
Change: delete EcsCanarySpikeServiceStack, then EcsCanarySpikeImageRepositoryStack
```

```bash
npm run preflight:aws
# 1. No deployment may be in progress; stop it if the observer shows one.
aws ecs stop-service-deployment --service-deployment-arn "$(current_service_deployment)" --stop-type ROLLBACK || true
# 2. Service stack first. Deleting from UPDATE_FAILED is allowed.
spike_cdk destroy "$SERVICE_STACK"
# 3. Then the repository (emptied on delete).
spike_cdk destroy "$REPOSITORY_STACK"
```

Stop the probe and observer, then verify:

```bash
for stack in "$SERVICE_STACK" "$REPOSITORY_STACK"; do
  aws cloudformation describe-stacks --stack-name "$stack" 2>&1 | grep -q 'does not exist' \
    && echo "$stack deleted" || echo "$stack STILL PRESENT"
done
aws resourcegroupstaggingapi get-resources --tag-filters Key=Spike,Values=infra-100 \
  --query 'ResourceTagMappingList[].ResourceARN'   # expect [] (allow a few minutes)
aws cloudwatch describe-alarms --alarm-name-prefix EcsCanarySpike \
  --alarm-types MetricAlarm CompositeAlarm --query '[MetricAlarms, CompositeAlarms][] | length(@)'
aws ecs list-clusters --query 'clusterArns' | grep -i spike || echo 'no spike cluster'
aws elbv2 describe-load-balancers --query 'LoadBalancers[].LoadBalancerName' | grep -i spike || echo 'no spike ALB'
aws ecr describe-repositories --query 'repositories[].repositoryName' | grep -i fixture || echo 'no fixture repository'
```

Optional: deregistered task-definition revisions remain `INACTIVE`, at no
cost. Delete them with `aws ecs delete-task-definitions` if wanted. Remove
the local images with `docker rmi`.

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
