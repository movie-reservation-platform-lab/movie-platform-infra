#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
ALLOWED_INGRESS_CIDR="${ALLOWED_INGRESS_CIDR:-203.0.113.10/32}"
APPLICATION_IMAGE_REFERENCE="${APPLICATION_IMAGE_REFERENCE:-111111111111.dkr.ecr.eu-central-1.amazonaws.com/ci-placeholder@sha256:0000000000000000000000000000000000000000000000000000000000000000}"
APPLICATION_SERVICE_VERSION="${APPLICATION_SERVICE_VERSION:-ci-contract-test}"

info() {
  printf 'info: %s\n' "$1"
}

ok() {
  printf 'ok: %s\n' "$1"
}

warn() {
  printf 'warn: %s\n' "$1"
}

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

require_file() {
  local path="$1"
  [ -f "$path" ] || fail "Missing required file: ${path}"
}

count_template_resources() {
  local template="$1"

  node -e '
    const fs = require("node:fs");
    const template = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    console.log(Object.keys(template.Resources ?? {}).length);
  ' "$template"
}

info "Validating standalone movie-platform-infra CDK app"
info "Repository root: ${REPO_ROOT}"
info "allowedIngressCidr: ${ALLOWED_INGRESS_CIDR}"

require_file "${REPO_ROOT}/package.json"
require_file "${REPO_ROOT}/cdk.json"

command -v npm >/dev/null 2>&1 || fail "npm is required"
command -v node >/dev/null 2>&1 || fail "node is required"

info "Running TypeScript build"
npm run build
ok "TypeScript build passed"

info "Running CDK assertion tests"
npm test
ok "CDK tests passed"

info "Synthesizing CloudFormation"
rm -rf "${REPO_ROOT}/cdk.out"
AWS_REGION=eu-central-1 CDK_DEFAULT_ACCOUNT=111111111111 CDK_DEFAULT_REGION=eu-central-1 \
  npm run cdk -- synth \
    --no-lookups \
    -c "allowedIngressCidr=${ALLOWED_INGRESS_CIDR}" \
    -c "applicationImageReference=${APPLICATION_IMAGE_REFERENCE}" \
    -c "applicationServiceVersion=${APPLICATION_SERVICE_VERSION}" \
    --quiet >/dev/null
ok "CDK synth passed"

template_count=0
while IFS= read -r -d '' template; do
  template_count=$((template_count + 1))
  resource_count="$(count_template_resources "$template")"
  template_size="$(wc -c < "$template")"
  stack_name="$(basename "$template" .template.json)"

  info "${stack_name}: ${resource_count} resources, ${template_size} bytes"

  if [ "$resource_count" -gt 200 ]; then
    warn "${stack_name}: high resource count; consider splitting stacks when this becomes hard to review"
  fi

  if [ "$template_size" -gt 51200 ]; then
    warn "${stack_name}: template is larger than 50 KB; watch for reviewability and CloudFormation limits"
  fi
done < <(find "${REPO_ROOT}/cdk.out" -name "*.template.json" -print0 2>/dev/null)

if [ "$template_count" -eq 0 ]; then
  fail "No synthesized templates found in ${REPO_ROOT}/cdk.out"
fi

if ! rg -q '"cdk-nag"|cdk-nag' "${REPO_ROOT}/package.json"; then
  warn "cdk-nag is not installed. That is acceptable for the current wave, but consider it before production-like hardening."
fi

ok "movie-platform-infra validation passed"
