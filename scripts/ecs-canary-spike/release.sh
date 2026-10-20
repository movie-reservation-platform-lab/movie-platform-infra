#!/usr/bin/env bash
# Image release for the ECS canary spike (infra#100), Session 3 ("pattern 2").
#
# A release changes only the image, in three steps, without CloudFormation:
#   1. render:   copy the recipe (the task definition CloudFormation created)
#                and swap in the new image digest;
#   2. register: register the copy as a new task definition revision;
#   3. deploy:   update-service to that revision, with alarm rollback on
#                (--mode revert) or off (--mode halt) for this release.
#
# Usage:
#   release.sh release --stack <name> --digest sha256:<64 hex> --mode revert|halt
#                      [--dry-run] [--skip-alarm-gate]
#   release.sh running --stack <name>
#   release.sh --self-test
#
# Pre-release gate: refuses to start while an ECS deployment is in flight, or
# unless every alarm the service watches is OK. --skip-alarm-gate is only for
# runs R5c-2, R6a, and R6b, which start a release under a bad alarm on purpose.
# --dry-run prints the rendered task definition and deployment configuration
# and changes nothing.
#
# `running` is read-only: it prints the running task definition, its digest,
# and whether the service is steady (one completed deployment), as JSON.
# infra-deploy.sh uses it.
#
# Uses the ambient AWS_PROFILE and AWS_REGION. Writes a line to
# $EVIDENCE_DIR/markers.txt when EVIDENCE_DIR is set.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE_DIR="$SCRIPT_DIR/../../test/fixtures/ecs-canary-spike/release"
CONTAINER_NAME='fixture'
DIGEST_PATTERN='^sha256:[0-9a-f]{64}$'
# ECS service deployment states that mean "a deployment is still moving".
IN_FLIGHT_STATES='PENDING IN_PROGRESS STOP_REQUESTED ROLLBACK_REQUESTED ROLLBACK_IN_PROGRESS'

usage() {
  sed -n '2,/^$/p' "$0" | sed -e '/^$/d' -e 's/^# \{0,1\}//'
  exit 2
}

die() {
  printf 'release.sh: %s\n' "$*" >&2
  exit 1
}

aws_bounded() {
  aws --cli-connect-timeout 5 --cli-read-timeout 30 "$@"
}

marker() {
  if [[ -n "${EVIDENCE_DIR:-}" ]]; then
    printf '%s %s\n' "$(date -u +%FT%T.%3NZ)" "$*" >>"${EVIDENCE_DIR}/markers.txt"
  fi
  printf '%s %s\n' "$(date -u +%FT%T.%3NZ)" "$*" >&2
}

stack_output() {
  local value
  value="$(aws_bounded cloudformation describe-stacks --stack-name "$1" --output text \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue | [0]")"
  [[ -n "$value" && "$value" != 'None' ]] || die "stack $1 has no output $2"
  printf '%s' "$value"
}

# --- Pure steps (no AWS calls; covered by --self-test) -----------------------

# Render: describe-task-definition output of the recipe -> input for
# register-task-definition with only the image digest changed. Read-only
# fields are dropped (ECS rejects them on register), and tags that start with
# "aws:" are dropped because only AWS may set them.
render_task_definition() {
  local recipe_file="$1" digest="$2"
  jq --arg container "$CONTAINER_NAME" --arg digest "$digest" '
    def fail(message): error("render: " + message);
    [.taskDefinition.containerDefinitions[] | select(.name == $container)] as $matches
    | if ($matches | length) != 1 then fail("expected exactly one container named \($container)")
      elif ($matches[0].image | test("@sha256:") | not) then fail("recipe image is not pinned by digest")
      else . end
    | (.taskDefinition
        | del(.taskDefinitionArn, .revision, .status, .requiresAttributes,
              .compatibilities, .registeredAt, .registeredBy, .deregisteredAt)
        | .containerDefinitions |= map(
            if .name == $container
            then .image = ((.image | split("@")[0]) + "@" + $digest)
            else . end))
      + {tags: ([.tags[]? | select(.key | startswith("aws:") | not)]
                + [{key: "ReleasedBy", value: "release.sh"}])}
  ' "$recipe_file"
}

# Deployment configuration for this release: the service's current settings
# (strategy, canary steps, bake time, alarm names) with only alarms.rollback
# chosen per release. revert = roll back on alarm; halt = stop where it is.
release_deployment_configuration() {
  local services_file="$1" mode="$2"
  jq --arg mode "$mode" '
    .services[0].deploymentConfiguration
    | if (.alarms.enable // false) | not
      then error("the service has no enabled deployment alarms") else . end
    | .alarms.rollback = ($mode == "revert")
  ' "$services_file"
}

# One "<alarm name> <state>" line for every alarm the service watches.
# A watched alarm that does not exist reports NOT_FOUND.
alarm_gate_report() {
  local services_file="$1" alarms_file="$2"
  jq -r --slurpfile services "$services_file" '
    ([.MetricAlarms[]?, .CompositeAlarms[]?] | map({key: .AlarmName, value: .StateValue}) | from_entries) as $state
    | $services[0].services[0].deploymentConfiguration.alarms.alarmNames[]
    | "\(.) \($state[.] // "NOT_FOUND")"
  ' "$alarms_file"
}

# Running revision summary from describe-services, the running task
# definition, and the number of in-flight service deployments.
running_summary() {
  local services_file="$1" task_definition_file="$2" in_flight="$3"
  jq --null-input --compact-output --arg container "$CONTAINER_NAME" --argjson inFlight "$in_flight" \
    --slurpfile services "$services_file" --slurpfile taskDefinition "$task_definition_file" '
    $services[0].services[0] as $service
    | {
        taskDefinitionArn: $service.taskDefinition,
        digest: ([$taskDefinition[0].taskDefinition.containerDefinitions[]
                  | select(.name == $container) | .image | split("@")[1]] | first),
        steady: (($service.deployments | length) == 1
                 and $service.deployments[0].rolloutState == "COMPLETED"
                 and $inFlight == 0),
        deployments: [$service.deployments[] | {status, rolloutState, taskDefinition}]
      }'
}

# --- AWS-facing commands -----------------------------------------------------

in_flight_count() {
  local cluster="$1" service="$2"
  # shellcheck disable=SC2086 # each state is a separate --status value
  aws_bounded ecs list-service-deployments --cluster "$cluster" --service "$service" \
    --status $IN_FLIGHT_STATES --query 'length(serviceDeployments)' --output text
}

run_running() {
  local stack=''
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --stack) stack="$2"; shift 2 ;;
      *) usage ;;
    esac
  done
  [[ -n "$stack" ]] || usage

  local cluster service tmp
  cluster="$(stack_output "$stack" ClusterName)"
  service="$(stack_output "$stack" ServiceName)"
  tmp="$(mktemp -d)"
  aws_bounded ecs describe-services --cluster "$cluster" --services "$service" >"$tmp/services.json"
  aws_bounded ecs describe-task-definition \
    --task-definition "$(jq -r '.services[0].taskDefinition' "$tmp/services.json")" >"$tmp/td.json"
  running_summary "$tmp/services.json" "$tmp/td.json" "$(in_flight_count "$cluster" "$service")"
  rm -rf "$tmp"
}

run_release() {
  local stack='' digest='' mode='' dry_run=0 skip_alarm_gate=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --stack) stack="$2"; shift 2 ;;
      --digest) digest="$2"; shift 2 ;;
      --mode) mode="$2"; shift 2 ;;
      --dry-run) dry_run=1; shift ;;
      --skip-alarm-gate) skip_alarm_gate=1; shift ;;
      *) usage ;;
    esac
  done
  [[ -n "$stack" ]] || usage
  [[ "$digest" =~ $DIGEST_PATTERN ]] || die "--digest must be sha256:<64 lowercase hex>"
  [[ "$mode" == revert || "$mode" == halt ]] || die "--mode must be revert or halt"

  local cluster service recipe tmp
  cluster="$(stack_output "$stack" ClusterName)"
  service="$(stack_output "$stack" ServiceName)"
  recipe="$(stack_output "$stack" RecipeTaskDefinitionArn)"
  RELEASE_TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$RELEASE_TMP_DIR"' EXIT
  tmp="$RELEASE_TMP_DIR"

  # Gate 1: never start a release on top of a moving deployment. A STOPPED
  # (halted) deployment is fine: rolling forward is how a halt is fixed.
  local in_flight
  in_flight="$(in_flight_count "$cluster" "$service")"
  [[ "$in_flight" == 0 ]] || die "an ECS deployment is still in flight ($in_flight); wait for it to finish"

  # Gate 2: every alarm the service watches must be OK. An alarm that is
  # already ALARM when a deployment starts can stop ECS from watching it (H7).
  aws_bounded ecs describe-services --cluster "$cluster" --services "$service" >"$tmp/services.json"
  local alarm_names
  alarm_names="$(jq -r '.services[0].deploymentConfiguration.alarms.alarmNames // [] | join(" ")' "$tmp/services.json")"
  [[ -n "$alarm_names" ]] || die "the service watches no deployment alarms"
  # shellcheck disable=SC2086 # each alarm name is a separate --alarm-names value
  aws_bounded cloudwatch describe-alarms --alarm-names $alarm_names \
    --alarm-types MetricAlarm CompositeAlarm >"$tmp/alarms.json"
  local report not_ok
  report="$(alarm_gate_report "$tmp/services.json" "$tmp/alarms.json")"
  printf 'pre-release gate, watched alarms:\n%s\n' "$report" | sed 's/^/  /' >&2
  not_ok="$(grep -cv ' OK$' <<<"$report" || true)"
  if [[ "$not_ok" != 0 ]]; then
    if [[ "$skip_alarm_gate" == 1 ]]; then
      printf 'release.sh: WARNING %s alarm(s) not OK; gate skipped on purpose (--skip-alarm-gate)\n' "$not_ok" >&2
    else
      die "$not_ok watched alarm(s) not OK; refusing to release (see above)"
    fi
  fi

  # Render.
  aws_bounded ecs describe-task-definition --task-definition "$recipe" --include TAGS >"$tmp/recipe.json"
  render_task_definition "$tmp/recipe.json" "$digest" >"$tmp/rendered.json"
  release_deployment_configuration "$tmp/services.json" "$mode" >"$tmp/deployment-configuration.json"

  if [[ "$dry_run" == 1 ]]; then
    printf -- '--- recipe: %s\n--- rendered task definition\n' "$recipe"
    cat "$tmp/rendered.json"
    printf -- '--- deployment configuration (mode %s)\n' "$mode"
    cat "$tmp/deployment-configuration.json"
    printf 'dry run: nothing registered or deployed\n'
    return 0
  fi

  # Register.
  local revision
  revision="$(aws_bounded ecs register-task-definition --cli-input-json "file://$tmp/rendered.json" \
    --query 'taskDefinition.taskDefinitionArn' --output text)"
  marker "release registered ${revision##*/} digest=${digest:7:12} mode=${mode} recipe=${recipe##*/}"

  # Deploy.
  aws_bounded ecs update-service --cluster "$cluster" --service "$service" \
    --task-definition "$revision" \
    --deployment-configuration "file://$tmp/deployment-configuration.json" \
    --query 'service.deployments[0].[status,rolloutState,taskDefinition]' --output text
  marker "release update-service ${revision##*/} mode=${mode}"
  printf 'started; follow it with the observer, or:\n  aws ecs list-service-deployments --cluster %s --service %s --max-results 1\n' \
    "$cluster" "$service"
}

# --- Self-test ---------------------------------------------------------------

self_test() {
  local failures=0 actual expected
  check() {
    local name="$1"
    if [[ "$actual" != "$expected" ]]; then
      printf 'release self-test failed: %s\n--- expected\n%s\n--- actual\n%s\n' "$name" "$expected" "$actual" >&2
      failures=$((failures + 1))
    fi
  }
  local digest_b="sha256:$(printf 'b%.0s' {1..64})"

  actual="$(render_task_definition "$FIXTURE_DIR/describe-task-definition-recipe.json" "$digest_b" | jq -S .)"
  expected="$(jq -S . "$FIXTURE_DIR/expected-rendered.json")"
  check 'render swaps only the digest'

  actual="$(release_deployment_configuration "$FIXTURE_DIR/describe-services-steady.json" halt | jq -S .)"
  expected="$(jq -S . "$FIXTURE_DIR/expected-deployment-configuration-halt.json")"
  check 'halt turns alarm rollback off and keeps the canary settings'

  actual="$(release_deployment_configuration "$FIXTURE_DIR/describe-services-steady.json" revert | jq -c .alarms)"
  expected="$(jq -c .services[0].deploymentConfiguration.alarms "$FIXTURE_DIR/describe-services-steady.json")"
  check 'revert keeps alarm rollback on'

  actual="$(alarm_gate_report "$FIXTURE_DIR/describe-services-steady.json" "$FIXTURE_DIR/describe-alarms-ok.json" | grep -cv ' OK$' || true)"
  expected=0
  check 'gate passes when every watched alarm is OK'

  actual="$(alarm_gate_report "$FIXTURE_DIR/describe-services-steady.json" "$FIXTURE_DIR/describe-alarms-bad.json")"
  expected="$(cat "$FIXTURE_DIR/expected-gate-bad.txt")"
  check 'gate reports INSUFFICIENT_DATA and missing alarms'

  actual="$(running_summary "$FIXTURE_DIR/describe-services-steady.json" "$FIXTURE_DIR/describe-task-definition-recipe.json" 0 | jq -c '[.steady, .digest]')"
  expected="[true,\"sha256:$(printf 'a%.0s' {1..64})\"]"
  check 'a single completed deployment is steady'

  actual="$(running_summary "$FIXTURE_DIR/describe-services-halted.json" "$FIXTURE_DIR/describe-task-definition-recipe.json" 0 | jq -c .steady)"
  expected=false
  check 'a halted canary split is not steady'

  actual="$(running_summary "$FIXTURE_DIR/describe-services-steady.json" "$FIXTURE_DIR/describe-task-definition-recipe.json" 1 | jq -c .steady)"
  expected=false
  check 'an in-flight deployment is not steady'

  actual="$(jq '.taskDefinition.containerDefinitions[0].image = "repo:latest"' \
    "$FIXTURE_DIR/describe-task-definition-recipe.json" \
    | render_task_definition /dev/stdin "$digest_b" 2>&1 >/dev/null | grep -c 'not pinned by digest' || true)"
  expected=1
  check 'render refuses a recipe image without a digest'

  [[ "$failures" == 0 ]] || exit 1
  printf 'ECS canary release self-test passed\n'
}

case "${1:-}" in
  release) shift; run_release "$@" ;;
  running) shift; run_running "$@" ;;
  --self-test) self_test ;;
  *) usage ;;
esac
