#!/usr/bin/env bash
# Infra deploy wrapper for the ECS canary spike (infra#100), Session 3.
#
# Releases register task definitions outside CloudFormation, so a raw
# `cdk deploy` would point the service back at the recipe (or at a stale
# ActiveTaskDefinitionArn) and roll out an old image. This wrapper always
# passes the revision ECS is running now, and refuses when it cannot read it.
# When the deploy changes the recipe (CPU, memory, environment), it releases
# the running image with the new recipe through release.sh, so the change
# rolls out through the same canary and alarms.
#
# Usage:
#   infra-deploy.sh diff   [-- <extra cdk args>]
#   infra-deploy.sh deploy [--recipe-release-mode revert|halt] [-- <extra cdk args>]
#   infra-deploy.sh bootstrap --digest sha256:<64 hex> [-- <extra cdk args>]
#
# bootstrap is the first deploy only (run R0b): the stack must not exist, and
# the service starts on the recipe with that digest. diff and deploy refuse
# unless the service is steady (one completed deployment, nothing in flight).
# Extra cdk args are usually context, e.g. -- -c spikeProfile=revert.
#
# Needs ALLOWED_INGRESS_PREFIX_LIST_ID and SPIKE_EXPIRES_ON (session.sh sets
# them) and the ambient AWS_PROFILE and AWS_REGION.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RELEASE="$SCRIPT_DIR/release.sh"
STACK='EcsCanarySpikeServiceStack'
DIGEST_PATTERN='^sha256:[0-9a-f]{64}$'

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

stack_exists() {
  aws cloudformation describe-stacks --stack-name "$STACK" >/dev/null 2>&1
}

recipe_arn() {
  aws cloudformation describe-stacks --stack-name "$STACK" --output text \
    --query "Stacks[0].Outputs[?OutputKey=='RecipeTaskDefinitionArn'].OutputValue | [0]"
}

# cdk diff|deploy for the service stack only, with the required context.
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
    printf '%s\n' "$running" | jq . >&2
    die "the service is not steady (a deployment is in flight or halted at a split); finish or roll forward first"
  fi
  printf '%s' "$running"
}

main() {
  local command="${1:-}"
  [[ -n "$command" ]] || usage
  shift
  local digest='' recipe_release_mode=revert
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --digest) digest="$2"; shift 2 ;;
      --recipe-release-mode) recipe_release_mode="$2"; shift 2 ;;
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
      spike_cdk deploy "$STACK" --exclusively --parameters "${STACK}:ImageDigest=${digest}" "$@"
      ;;
    diff|deploy)
      [[ -z "$digest" ]] || die "--digest is only for bootstrap; releases go through release.sh"
      stack_exists || die "$STACK does not exist; use bootstrap first"
      local running running_arn running_digest recipe_before recipe_after after
      running="$(steady_running_revision)"
      running_arn="$(jq -r .taskDefinitionArn <<<"$running")"
      running_digest="$(jq -r .digest <<<"$running")"
      printf 'running: %s (digest %s)\n' "${running_arn##*/}" "${running_digest:7:12}" >&2

      if [[ "$command" == diff ]]; then
        spike_cdk diff "$STACK" --parameters "${STACK}:ActiveTaskDefinitionArn=${running_arn}" "$@"
        return
      fi

      recipe_before="$(recipe_arn)"
      marker "infra-deploy deploy active=${running_arn##*/} recipe=${recipe_before##*/}"
      # ImageDigest is not passed: cdk reuses the previous value, so the
      # recipe changes only when the CDK code or context changes it.
      spike_cdk deploy "$STACK" --exclusively --parameters "${STACK}:ActiveTaskDefinitionArn=${running_arn}" "$@"
      recipe_after="$(recipe_arn)"

      after="$("$RELEASE" running --stack "$STACK")"
      if [[ "$(jq -r .taskDefinitionArn <<<"$after")" != "$running_arn" ]]; then
        printf 'infra-deploy.sh: WARNING the service no longer runs %s after the deploy:\n' "${running_arn##*/}" >&2
        jq . <<<"$after" >&2
      fi

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

main "$@"
