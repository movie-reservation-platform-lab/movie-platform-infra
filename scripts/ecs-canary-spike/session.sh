# Operator session for the ECS canary spike (infra#100).
#
# Source it, from the repository root, in every terminal used for the spike.
# It works in bash and zsh:
#
#   source scripts/ecs-canary-spike/session.sh
#
# Private values stay out of Git: put them in .local/ecs-canary-spike/session.env
# (gitignored), for example:
#
#   export ALLOWED_INGRESS_PREFIX_LIST_ID='pl-...'
#   export SPIKE_EXPIRES_ON='YYYY-MM-DD'
#
# Portability rules: no bash arrays, no ${!var}, braces around every variable
# followed by ':' (zsh reads $var:x as a modifier), "$@" for optional flags,
# and no `exit` (it would close the operator's shell).

SPIKE_REPO_ROOT="${SPIKE_REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)}"
if [ -z "$SPIKE_REPO_ROOT" ] || [ ! -f "${SPIKE_REPO_ROOT}/scripts/ecs-canary-spike/session.sh" ]; then
  echo "session.sh: source it from the movie-platform-infra repository root" >&2
  return 1
fi
export SPIKE_REPO_ROOT
SPIKE_LOCAL_DIR="${SPIKE_REPO_ROOT}/.local/ecs-canary-spike"

if [ -f "${SPIKE_LOCAL_DIR}/session.env" ]; then
  . "${SPIKE_LOCAL_DIR}/session.env"
fi

export AWS_PROFILE="${AWS_PROFILE_SPIKE:-movie-platform-workload-development}"
export AWS_REGION=eu-central-1
export AWS_PAGER=''   # no "(END)" pager on AWS CLI output
export MOVIE_PLATFORM_AWS_TARGET_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/movie-platform/workload-development-aws-target.json"
export SERVICE_STACK=EcsCanarySpikeServiceStack
export REPOSITORY_STACK=EcsCanarySpikeImageRepositoryStack

# One evidence directory per day. A terminal that already has EVIDENCE_DIR
# keeps it, so the terminals of one session write to the same place.
export EVIDENCE_DIR="${EVIDENCE_DIR:-${SPIKE_LOCAL_DIR}/$(date +%F)}"
mkdir -p "$EVIDENCE_DIR"

# Digests from the most recent R0 image push (valid while the repository stack exists).
SPIKE_DIGESTS_FILE="${SPIKE_DIGESTS_FILE:-$(find "$SPIKE_LOCAL_DIR" -name digests.env -type f 2>/dev/null | sort | tail -n 1)}"
if [ -n "$SPIKE_DIGESTS_FILE" ]; then
  . "$SPIKE_DIGESTS_FILE"
fi

for spike_required in ALLOWED_INGRESS_PREFIX_LIST_ID SPIKE_EXPIRES_ON; do
  if [ -z "$(eval "printf '%s' \"\${${spike_required}:-}\"")" ]; then
    echo "session.sh: ${spike_required} is not set (see .local/ecs-canary-spike/session.env)" >&2
  fi
done
unset spike_required

# Timestamped note in markers.txt, e.g. marker "R2 start".
marker() {
  printf '%s %s\n' "$(date -u +%FT%T.%3NZ)" "$*" | tee -a "${EVIDENCE_DIR}/markers.txt"
}

# CDK for the spike app with the required context. Extra -c flags select the profile.
spike_cdk() {
  (cd "$SPIKE_REPO_ROOT" && npm run cdk --workspace @movie-platform/ecs-canary-alarm-spike -- "$@" \
    -c allowedIngressPrefixListId="$ALLOWED_INGRESS_PREFIX_LIST_ID" \
    -c expiresOn="$SPIKE_EXPIRES_ON")
}

stack_output() {
  aws cloudformation describe-stacks --stack-name "$1" --output text \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue | [0]"
}

# Change only the image digest, with the same template: the pipeline primitive.
#   spike_update_digest "$DIGEST_GOOD_2" enable
# "disable" is kept to reproduce the R1 finding: CloudFormation rejects
# --disable-rollback for replacement updates, and every digest change
# replaces the task definition.
spike_update_digest() {
  local digest="$1" mode="$2"
  case "$digest" in
    sha256:*) ;;
    *) echo "spike_update_digest: digest must start with sha256: (got '${digest}')" >&2; return 2 ;;
  esac
  case "$mode" in
    enable) set -- ;;
    disable) set -- --disable-rollback ;;
    *) echo "usage: spike_update_digest <sha256:...> <enable|disable>" >&2; return 2 ;;
  esac
  marker "update-stack ImageDigest=$(spike_digest_label "$digest") rollback=${mode}"
  aws cloudformation update-stack --stack-name "$SERVICE_STACK" \
    --use-previous-template --capabilities CAPABILITY_IAM \
    --parameters "ParameterKey=ImageDigest,ParameterValue=${digest}" \
                 ParameterKey=BootstrapVersion,UsePreviousValue=true \
    "$@"
}

# Session 3 ("pattern 2"): releases go through ECS, infra through the wrapper.
#   spike_release "$DIGEST_GOOD_2" revert            # or halt
#   spike_release "$DIGEST_GOOD_1" revert --skip-alarm-gate   # R5c-2, R6a, R6b only
#   spike_release "$DIGEST_GOOD_2" revert --dry-run  # show, change nothing
spike_release() {
  local digest="$1" mode="$2"
  if [ $# -lt 2 ]; then
    echo "usage: spike_release <sha256:...> <revert|halt> [--dry-run] [--skip-alarm-gate]" >&2
    return 2
  fi
  shift 2
  marker "release request $(spike_digest_label "$digest") mode=${mode} $*"
  "${SPIKE_REPO_ROOT}/scripts/ecs-canary-spike/release.sh" release --stack "$SERVICE_STACK" \
    --digest "$digest" --mode "$mode" "$@"
}

# Infra deploys always carry the running revision. The context comes from
# these variables, so every deploy in a session repeats the same values and a
# forgotten flag cannot silently change the recipe:
#   SPIKE_PROFILE (revert), SPIKE_BRIDGE_MISSING_DATA (notBreaching),
#   SPIKE_INFRA_REVISION (1), SPIKE_RECIPE_REVISION (1),
#   SPIKE_FAIL_INFRA_DEPLOY (false; true only for run R5c-4)
# Examples (do not pass `--`; the helper adds it):
#   spike_infra_deploy diff
#   spike_infra_deploy deploy
#   spike_infra_deploy deploy --no-sync     # run R5c-4a only
#   spike_infra_deploy bootstrap --digest "$DIGEST_GOOD_1"
spike_infra_deploy() {
  "${SPIKE_REPO_ROOT}/scripts/ecs-canary-spike/infra-deploy.sh" "$@" -- \
    -c spikeProfile="${SPIKE_PROFILE:-revert}" \
    -c bridgeMissingData="${SPIKE_BRIDGE_MISSING_DATA:-notBreaching}" \
    -c infraRevision="${SPIKE_INFRA_REVISION:-1}" \
    -c recipeRevision="${SPIKE_RECIPE_REVISION:-1}" \
    -c failInfraDeploy="${SPIKE_FAIL_INFRA_DEPLOY:-false}"
}

# good-1 / good-2 / bad-5xx / crash for a digest.
spike_digest_label() {
  case "$1" in
    "${DIGEST_GOOD_1:-unset}") echo good-1 ;;
    "${DIGEST_GOOD_2:-unset}") echo good-2 ;;
    "${DIGEST_BAD_5XX:-unset}") echo bad-5xx ;;
    "${DIGEST_CRASH:-unset}") echo crash ;;
    *) echo "unknown(${1})" ;;
  esac
}

# The service's newest ECS service deployment ARN.
current_service_deployment() {
  aws ecs list-service-deployments \
    --cluster "$(stack_output "$SERVICE_STACK" ClusterName)" \
    --service "$(stack_output "$SERVICE_STACK" ServiceName)" \
    --max-results 1 --query 'serviceDeployments[0].serviceDeploymentArn' --output text
}

# Instruments. The optional argument is a file prefix, e.g. `spike_probe R2`
# writes R2-probe.csv.
spike_probe() {
  local dns
  dns="$(stack_output "$SERVICE_STACK" LoadBalancerDnsName 2>/dev/null)"
  case "$dns" in
    ''|None) echo "spike_probe: no ALB DNS name (service stack up? SSO session valid?)" >&2; return 1 ;;
  esac
  "${SPIKE_REPO_ROOT}/scripts/ecs-canary-spike/probe.sh" run --url "http://${dns}/" \
    --out "${EVIDENCE_DIR}/${1:+${1}-}probe.csv" --rate 5
}

spike_observe() {
  "${SPIKE_REPO_ROOT}/scripts/ecs-canary-spike/observe.sh" run --stack "$SERVICE_STACK" \
    --out "${EVIDENCE_DIR}/${1:+${1}-}observer.jsonl" --interval 10
}

# Read-only one-screen status.
spike_status() {
  local stack stack_status digest running
  echo "evidence: ${EVIDENCE_DIR}"
  for stack in "$REPOSITORY_STACK" "$SERVICE_STACK"; do
    stack_status="$(aws cloudformation describe-stacks --stack-name "$stack" \
      --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo 'DOES NOT EXIST')"
    echo "${stack}: ${stack_status}"
  done
  digest="$(aws cloudformation describe-stacks --stack-name "$SERVICE_STACK" \
    --query "Stacks[0].Parameters[?ParameterKey=='ImageDigest'].ParameterValue | [0]" \
    --output text 2>/dev/null)"
  if [ -n "$digest" ]; then
    echo "service digest parameter: $(spike_digest_label "$digest") (Session 3: the recipe only)"
    running="$("${SPIKE_REPO_ROOT}/scripts/ecs-canary-spike/release.sh" running --stack "$SERVICE_STACK" 2>/dev/null)"
    if [ -n "$running" ]; then
      echo "running: $(printf '%s' "$running" | jq -r '.taskDefinitionArn | split("/")[1]')" \
        "image $(spike_digest_label "$(printf '%s' "$running" | jq -r .digest)")" \
        "steady=$(printf '%s' "$running" | jq -r .steady)"
    fi
  fi
  aws cloudwatch describe-alarms --alarm-name-prefix EcsCanarySpike \
    --alarm-types MetricAlarm CompositeAlarm \
    --query '[MetricAlarms[].[AlarmName,StateValue], CompositeAlarms[].[AlarmName,StateValue]][]' \
    --output text 2>/dev/null
}
