#!/usr/bin/env bash
# Timeline observer for the ECS canary spike (infra#100).
#
# Polls ECS, ELB, CloudFormation, and CloudWatch with read-only AWS CLI calls
# and appends one JSON line per poll: deployment status and lifecycle stage,
# listener-rule weights (the authoritative traffic split), target health,
# stack status, recent stack events, and alarm states.
#
# Usage:
#   observe.sh run --stack EcsCanarySpikeServiceStack --out <file.jsonl> [--interval 10]
#   observe.sh --self-test
#
# Uses the ambient AWS_PROFILE and AWS_REGION. Run `npm run preflight:aws` first.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE_DIR="$SCRIPT_DIR/../../test/fixtures/ecs-canary-spike/observe"
ALARM_PREFIX='EcsCanarySpike'

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

# Build one snapshot line from the raw responses saved in directory $1.
build_snapshot() {
  local dir="$1" observed_at="$2"
  jq --compact-output --null-input \
    --arg observedAt "$observed_at" \
    --slurpfile services "$dir/describe-services.json" \
    --slurpfile deployments "$dir/describe-service-deployments.json" \
    --slurpfile rules "$dir/describe-rules.json" \
    --slurpfile blueHealth "$dir/target-health-blue.json" \
    --slurpfile greenHealth "$dir/target-health-green.json" \
    --slurpfile stacks "$dir/describe-stacks.json" \
    --slurpfile stackEvents "$dir/describe-stack-events.json" \
    --slurpfile alarms "$dir/describe-alarms.json" '
    def healthy(h): [h.TargetHealthDescriptions[]? | select(.TargetHealth.State == "healthy")] | length;
    {
      observedAt: $observedAt,
      service: ($services[0].services[0] | {
        status, desiredCount, runningCount, pendingCount,
        deployments: [.deployments[]? | {
          status, rolloutState, rolloutStateReason, taskDefinition,
          runningCount, failedTasks
        }]
      }),
      serviceDeployments: [$deployments[0].serviceDeployments[]? | {
        arn: .serviceDeploymentArn, status, statusReason, lifecycleStage,
        targetRevision: .targetServiceRevision.arn,
        rollback, circuitBreaker: .deploymentCircuitBreaker, alarms
      }],
      ruleWeights: [$rules[0].Rules[0].Actions[]? | select(.Type == "forward")
        | .ForwardConfig.TargetGroups[]? | {targetGroupArn: .TargetGroupArn, weight: .Weight}],
      healthyTargets: {blue: healthy($blueHealth[0]), green: healthy($greenHealth[0])},
      stackStatus: $stacks[0].Stacks[0].StackStatus,
      recentStackEvents: [$stackEvents[0].StackEvents[0:5][]? | {
        id: .EventId, time: .Timestamp, resource: .LogicalResourceId,
        status: .ResourceStatus, reason: .ResourceStatusReason
      }],
      alarms: (
        [$alarms[0].MetricAlarms[]?, $alarms[0].CompositeAlarms[]?]
        | map({key: .AlarmName, value: .StateValue}) | from_entries
      )
    }'
}

stack_output() {
  local stack="$1" key="$2"
  aws cloudformation describe-stacks --stack-name "$stack" --output text \
    --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue | [0]"
}

run_observer() {
  local stack='' out='' interval=10
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --stack) stack="$2"; shift 2 ;;
      --out) out="$2"; shift 2 ;;
      --interval) interval="$2"; shift 2 ;;
      *) usage ;;
    esac
  done
  [[ -n "$stack" && -n "$out" && "$interval" =~ ^[1-9][0-9]*$ ]] || usage

  local cluster service rule blue green
  cluster="$(stack_output "$stack" ClusterName)"
  service="$(stack_output "$stack" ServiceName)"
  rule="$(stack_output "$stack" ProductionListenerRuleArn)"
  blue="$(stack_output "$stack" BlueTargetGroupArn)"
  green="$(stack_output "$stack" GreenTargetGroupArn)"

  local dir
  dir="$(mktemp -d)"
  trap 'rm -rf "$dir"' EXIT
  printf 'observing %s every %ss into %s (Ctrl-C to stop)\n' "$stack" "$interval" "$out" >&2
  while true; do
    aws ecs describe-services --cluster "$cluster" --services "$service" >"$dir/describe-services.json"
    local arns
    arns="$(aws ecs list-service-deployments --cluster "$cluster" --service "$service" \
      --max-results 3 --query 'serviceDeployments[].serviceDeploymentArn' --output text)"
    if [[ -n "$arns" && "$arns" != 'None' ]]; then
      # shellcheck disable=SC2086 # word splitting passes each ARN separately
      aws ecs describe-service-deployments --service-deployment-arns $arns \
        >"$dir/describe-service-deployments.json"
    else
      printf '{"serviceDeployments":[]}' >"$dir/describe-service-deployments.json"
    fi
    aws elbv2 describe-rules --rule-arns "$rule" >"$dir/describe-rules.json"
    aws elbv2 describe-target-health --target-group-arn "$blue" >"$dir/target-health-blue.json"
    aws elbv2 describe-target-health --target-group-arn "$green" >"$dir/target-health-green.json"
    aws cloudformation describe-stacks --stack-name "$stack" >"$dir/describe-stacks.json"
    aws cloudformation describe-stack-events --stack-name "$stack" --max-items 5 \
      >"$dir/describe-stack-events.json"
    aws cloudwatch describe-alarms --alarm-name-prefix "$ALARM_PREFIX" \
      --alarm-types MetricAlarm CompositeAlarm >"$dir/describe-alarms.json"
    build_snapshot "$dir" "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" >>"$out"
    sleep "$interval"
  done
}

self_test() {
  local actual expected
  actual="$(build_snapshot "$FIXTURE_DIR" '2026-10-16T12:00:00.000Z')"
  expected="$(jq --compact-output . "$FIXTURE_DIR/expected-snapshot.json")"
  if [[ "$actual" != "$expected" ]]; then
    printf 'observer self-test failed\n--- expected\n%s\n--- actual\n%s\n' "$expected" "$actual" >&2
    exit 1
  fi
  printf 'ECS canary observer self-test passed\n'
}

case "${1:-}" in
  run) shift; run_observer "$@" ;;
  --self-test) self_test ;;
  *) usage ;;
esac
