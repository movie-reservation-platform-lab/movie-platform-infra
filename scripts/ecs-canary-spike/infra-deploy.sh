#!/usr/bin/env bash
# Infra deploy wrapper for the ECS canary spike (infra#100), Session 3.
#
# Releases register task definitions outside CloudFormation. An infra deploy
# must therefore keep the service on the revision ECS runs now, including
# when the deploy fails and CloudFormation rolls back. The wrapper:
#   1. refuses unless the service is steady, and reads the running revision;
#   2. sync phase: if the deployed template names an older revision, updates
#      the stack with that same template and only the service's task
#      definition changed to the running one. A later rollback then returns
#      to the running revision, not to an older one;
#   3. deploys the CDK change with -c activeTaskDefinitionArn=<running>;
#   4. if the recipe changed (CPU, memory, environment), releases the running
#      image with the new recipe through release.sh.
#
# Usage:
#   infra-deploy.sh diff   [-- <extra cdk args>]
#   infra-deploy.sh deploy [--recipe-release-mode revert|halt] [--no-sync] [-- <extra cdk args>]
#   infra-deploy.sh bootstrap --digest sha256:<64 hex> [-- <extra cdk args>]
#   infra-deploy.sh --self-test
#
# bootstrap is the first deploy only (run R0b): the stack must not exist, and
# the service starts on the recipe with that digest. --no-sync skips step 2;
# it exists only for run R5c-4a, which shows the rollback hole it closes.
# Extra cdk args are usually context, e.g. -- -c spikeProfile=revert.
# Releases and infra deploys must not overlap: one operator, one terminal.
#
# Needs ALLOWED_INGRESS_PREFIX_LIST_ID and SPIKE_EXPIRES_ON (session.sh sets
# them) and the ambient AWS_PROFILE and AWS_REGION.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FIXTURE_DIR="$REPO_ROOT/test/fixtures/ecs-canary-spike/infra-deploy"
RELEASE="$SCRIPT_DIR/release.sh"
STACK='EcsCanarySpikeServiceStack'
DIGEST_PATTERN='^sha256:[0-9a-f]{64}$'
# update-stack --template-body limit; larger templates would need S3.
TEMPLATE_BODY_LIMIT=51200

usage() {
  sed -n '2,/^$/p' "$0" | sed -e '/^$/d' -e 's/^# \{0,1\}//'
  exit 2
}

die() {
  printf 'infra-deploy.sh: %s\n' "$*" >&2
  exit 1
}

marker() {
  if [[ -n "${EVIDENCE_DIR:-}" ]]; then
    printf '%s %s\n' "$(date -u +%FT%T.%3NZ)" "$*" >>"${EVIDENCE_DIR}/markers.txt"
  fi
  printf '%s %s\n' "$(date -u +%FT%T.%3NZ)" "$*" >&2
}

# --- Pure steps (no AWS calls; covered by --self-test) -----------------------

# The service's TaskDefinition property in a template, as compact JSON:
# a quoted ARN, or an object such as {"Ref":"TaskDefinition..."}.
service_task_definition() {
  jq --compact-output '
    [.Resources[] | select(.Type == "AWS::ECS::Service")]
    | if length != 1 then error("expected exactly one AWS::ECS::Service") else . end
    | .[0].Properties.TaskDefinition' "$1"
}

# The same template with only the service's TaskDefinition replaced.
sync_template() {
  jq --compact-output --arg arn "$2" '
    if (.Resources | type) != "object" then error("not a JSON template") else . end
    | ([.Resources | to_entries[] | select(.value.Type == "AWS::ECS::Service") | .key]) as $ids
    | if ($ids | length) != 1 then error("expected exactly one AWS::ECS::Service") else . end
    | .Resources[$ids[0]].Properties.TaskDefinition = $arn' "$1"
}

# --- AWS-facing steps ----------------------------------------------------------

stack_exists() {
  aws cloudformation describe-stacks --stack-name "$STACK" >/dev/null 2>&1
}

recipe_arn() {
  aws cloudformation describe-stacks --stack-name "$STACK" --output text \
    --query "Stacks[0].Outputs[?OutputKey=='RecipeTaskDefinitionArn'].OutputValue | [0]"
}

# cdk diff|deploy with the required context.
spike_cdk() {
  (cd "$REPO_ROOT" && npm run cdk --workspace @movie-platform/ecs-canary-alarm-spike -- "$@" \
    -c allowedIngressPrefixListId="$ALLOWED_INGRESS_PREFIX_LIST_ID" \
    -c expiresOn="$SPIKE_EXPIRES_ON")
}

# Prints the running revision as JSON, or exits if the service is not steady.
steady_running_revision() {
  local running
  running="$("$RELEASE" running --stack "$STACK")" || die "cannot read the running revision; refusing"
  if [[ "$(jq -r .steady <<<"$running")" != true ]]; then
    jq . <<<"$running" >&2
    die "the service is not steady (a deployment is in flight or halted at a split); finish or roll forward first"
  fi
  printf '%s' "$running"
}

# Step 2. Uses the deployed template, not the new CDK output, so this update
# changes one property and nothing else. ECS already runs that revision, so
# CloudFormation's UpdateService call should not start a deployment (H14).
sync_deployed_revision() {
  local running_arn="$1" tmp deployed parameters=()
  tmp="$(mktemp -d)"
  aws cloudformation get-template --stack-name "$STACK" --template-stage Original \
    --query TemplateBody --output json >"$tmp/deployed.json"
  deployed="$(service_task_definition "$tmp/deployed.json")" || die "cannot read the deployed template"
  if [[ "$deployed" == "\"$running_arn\"" ]]; then
    marker "infra-deploy sync: deployed template already names ${running_arn##*/}"
    rm -rf "$tmp"
    return
  fi
  sync_template "$tmp/deployed.json" "$running_arn" >"$tmp/synced.json"
  (( $(wc -c <"$tmp/synced.json") <= TEMPLATE_BODY_LIMIT )) \
    || die "synced template exceeds ${TEMPLATE_BODY_LIMIT} bytes; it would need S3"
  local key
  for key in $(aws cloudformation describe-stacks --stack-name "$STACK" \
      --query 'Stacks[0].Parameters[].ParameterKey' --output text); do
    parameters+=("ParameterKey=${key},UsePreviousValue=true")
  done

  marker "infra-deploy sync: deployed template names ${deployed}; updating it to ${running_arn##*/}"
  local output
  if ! output="$(aws cloudformation update-stack --stack-name "$STACK" \
      --template-body "file://$tmp/synced.json" --capabilities CAPABILITY_IAM \
      --parameters "${parameters[@]}" --query StackId --output text 2>&1)"; then
    # A Ref that already resolves to the running revision is not a change.
    if grep -q 'No updates are to be performed' <<<"$output"; then
      marker "infra-deploy sync: CloudFormation reports no change; already in sync"
      rm -rf "$tmp"
      return
    fi
    die "sync update was rejected: $output"
  fi
  aws cloudformation wait stack-update-complete --stack-name "$STACK" \
    || die "sync update did not complete; inspect the stack before anything else"
  marker "infra-deploy sync: complete"
  rm -rf "$tmp"
}

# Compare the service before and after, and say so loudly if it moved.
report_running_after() {
  local running_arn="$1" after
  after="$("$RELEASE" running --stack "$STACK")" || return 0
  if [[ "$(jq -r .taskDefinitionArn <<<"$after")" != "$running_arn" ]]; then
    printf 'infra-deploy.sh: WARNING the service no longer targets %s:\n' "${running_arn##*/}" >&2
    jq . <<<"$after" >&2
  fi
}

main() {
  local command="${1:-}"
  [[ -n "$command" ]] || usage
  shift
  local digest='' recipe_release_mode=revert sync=1
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --digest) digest="$2"; shift 2 ;;
      --recipe-release-mode) recipe_release_mode="$2"; shift 2 ;;
      --no-sync) sync=0; shift ;;
      --) shift; break ;;
      *) usage ;;
    esac
  done
  # Whatever is left in "$@" goes to cdk unchanged.
  [[ -n "${ALLOWED_INGRESS_PREFIX_LIST_ID:-}" && -n "${SPIKE_EXPIRES_ON:-}" ]] \
    || die "ALLOWED_INGRESS_PREFIX_LIST_ID and SPIKE_EXPIRES_ON must be set (source session.sh)"
  [[ "$recipe_release_mode" == revert || "$recipe_release_mode" == halt ]] \
    || die "--recipe-release-mode must be revert or halt"

  case "$command" in
    bootstrap)
      [[ "$digest" =~ $DIGEST_PATTERN ]] || die "bootstrap needs --digest sha256:<64 lowercase hex>"
      ! stack_exists || die "$STACK already exists; bootstrap is for the first deploy only"
      marker "infra-deploy bootstrap digest=${digest:7:12}"
      spike_cdk deploy "$STACK" --exclusively -c activeTaskDefinitionArn=bootstrap-recipe \
        --parameters "${STACK}:ImageDigest=${digest}" "$@"
      ;;
    diff|deploy)
      [[ -z "$digest" ]] || die "--digest is only for bootstrap; releases go through release.sh"
      stack_exists || die "$STACK does not exist; use bootstrap first"
      local running running_arn running_digest recipe_before recipe_after
      running="$(steady_running_revision)"
      running_arn="$(jq -r .taskDefinitionArn <<<"$running")"
      running_digest="$(jq -r .digest <<<"$running")"
      printf 'running: %s (digest %s)\n' "${running_arn##*/}" "${running_digest:7:12}" >&2

      if [[ "$command" == diff ]]; then
        spike_cdk diff "$STACK" -c activeTaskDefinitionArn="$running_arn" "$@"
        return
      fi

      if [[ "$sync" == 1 ]]; then
        sync_deployed_revision "$running_arn"
      else
        marker "infra-deploy sync: SKIPPED (--no-sync, run R5c-4a only)"
      fi

      recipe_before="$(recipe_arn)"
      marker "infra-deploy deploy active=${running_arn##*/} recipe=${recipe_before##*/}"
      # ImageDigest is not passed: cdk reuses the previous value. It only
      # feeds the recipe, which releases override with their own digest.
      if ! spike_cdk deploy "$STACK" --exclusively -c activeTaskDefinitionArn="$running_arn" "$@"; then
        marker "infra-deploy deploy FAILED (the stack rolled back or is stuck)"
        report_running_after "$running_arn"
        exit 1
      fi
      recipe_after="$(recipe_arn)"
      report_running_after "$running_arn"

      if [[ "$recipe_after" == "$recipe_before" ]]; then
        marker "infra-deploy done; recipe unchanged (${recipe_after##*/}); no release"
        return
      fi
      marker "infra-deploy done; recipe changed ${recipe_before##*/} -> ${recipe_after##*/}; releasing the running digest"
      "$RELEASE" release --stack "$STACK" --digest "$running_digest" --mode "$recipe_release_mode"
      ;;
    *) usage ;;
  esac
}

self_test() {
  local failures=0 actual expected
  local running='arn:aws:ecs:eu-central-1:111111111111:task-definition/SpikeFamily:7'
  check() {
    if [[ "$actual" != "$expected" ]]; then
      printf 'infra-deploy self-test failed: %s\n--- expected\n%s\n--- actual\n%s\n' "$1" "$expected" "$actual" >&2
      failures=$((failures + 1))
    fi
  }

  actual="$(service_task_definition "$FIXTURE_DIR/deployed-template.json")"
  expected='{"Ref":"TaskDefinitionB36D86D9"}'
  check 'reads the deployed service task definition'

  actual="$(sync_template "$FIXTURE_DIR/deployed-template.json" "$running" | jq -S .)"
  expected="$(jq -S . "$FIXTURE_DIR/expected-synced-template.json")"
  check 'sync changes only the service task definition'

  actual="$(jq '.Resources.Second = .Resources.Service' "$FIXTURE_DIR/deployed-template.json" \
    | sync_template /dev/stdin "$running" 2>&1 >/dev/null | grep -c 'exactly one' || true)"
  expected=1
  check 'sync refuses a template with two services'

  [[ "$failures" == 0 ]] || exit 1
  printf 'ECS canary infra-deploy self-test passed\n'
}

case "${1:-}" in
  --self-test) self_test ;;
  *) main "$@" ;;
esac
