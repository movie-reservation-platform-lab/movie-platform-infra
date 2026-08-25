#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  integrated-demo-smoke.sh --base-url <http-url> [--report <path>]
  integrated-demo-smoke.sh --self-test

Runs the web health check and the happy, slow-recommendation, and
recommendation-error scenarios through the public web route. The script does
not call AWS APIs; the ALB base URL must come from a reviewed stack output.
EOF
}

fail() {
  printf 'Integrated demo smoke failed: %s\n' "$1" >&2
  exit 1
}

validate_response() {
  local scenario="$1"
  local expected_status="$2"
  local actual_status="$3"
  local response_file="$4"
  local duration_ms="$5"

  node - "$scenario" "$expected_status" "$actual_status" "$response_file" "$duration_ms" <<'NODE'
const fs = require('node:fs');

const [scenario, expectedStatus, actualStatus, responsePath, durationText] = process.argv.slice(2);
if (actualStatus !== expectedStatus) {
  throw new Error(`${scenario}: expected HTTP ${expectedStatus}, received ${actualStatus}`);
}

const response = JSON.parse(fs.readFileSync(responsePath, 'utf8'));
const durationMs = Number(durationText);
if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
  throw new Error(`${scenario}: invalid duration`);
}

if (scenario === 'health') {
  if (response.status !== 'ok' || response.service !== 'movie-reservation-web') {
    throw new Error('health: response did not identify the healthy web container');
  }
} else if (scenario === 'happy' || scenario === 'slow-recommendation') {
  if (response.outcome !== 'confirmed' || response.trace?.trace_id === undefined) {
    throw new Error(`${scenario}: reservation was not confirmed with a trace ID`);
  }
  if (scenario === 'slow-recommendation' && durationMs < 1500) {
    throw new Error('slow-recommendation: response completed before the controlled delay');
  }
} else if (
  response.error !== 'demo_dependency_failed'
  || response.message !== 'recommendation_dependency_failed'
  || response.trace?.trace_id === undefined
) {
  throw new Error('recommendation-error: bounded dependency error contract was not returned');
}
NODE
}

run_self_test() {
  local directory
  directory="$(mktemp -d)"
  trap 'rm -rf "${directory}"' RETURN

  printf '{"status":"ok","service":"movie-reservation-web"}' >"${directory}/health.json"
  printf '{"outcome":"confirmed","trace":{"trace_id":"11111111111111111111111111111111"}}' >"${directory}/success.json"
  printf '{"error":"demo_dependency_failed","message":"recommendation_dependency_failed","trace":{"trace_id":"22222222222222222222222222222222"}}' >"${directory}/error.json"

  validate_response health 200 200 "${directory}/health.json" 1
  validate_response happy 200 200 "${directory}/success.json" 25
  validate_response slow-recommendation 200 200 "${directory}/success.json" 2000
  validate_response recommendation-error 502 502 "${directory}/error.json" 25

  if validate_response slow-recommendation 200 200 "${directory}/success.json" 25 >/dev/null 2>&1; then
    fail 'self-test accepted a slow scenario without the controlled delay'
  fi

  printf 'Integrated demo smoke helper self-test passed\n'
}

base_url="${DEMO_BASE_URL:-}"
report_path=''
self_test='false'

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url)
      [[ $# -ge 2 ]] || fail '--base-url requires a value'
      base_url="$2"
      shift 2
      ;;
    --report)
      [[ $# -ge 2 ]] || fail '--report requires a value'
      report_path="$2"
      shift 2
      ;;
    --self-test)
      self_test='true'
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

if [[ "${self_test}" == 'true' ]]; then
  run_self_test
  exit 0
fi

for required_command in curl jq node; do
  command -v "${required_command}" >/dev/null 2>&1 || fail "${required_command} is required"
done

[[ "${base_url}" =~ ^https?://[^[:space:]]+$ ]] || fail '--base-url must be an absolute HTTP(S) URL'
base_url="${base_url%/}"

if [[ -n "${report_path}" ]]; then
  [[ ! -d "${report_path}" ]] || fail 'report path must not be a directory'
  report_directory="$(dirname -- "${report_path}")"
  [[ -d "${report_directory}" && -w "${report_directory}" ]] || fail 'report directory must exist and be writable'
fi

working_directory="$(mktemp -d)"
trap 'rm -rf "${working_directory}"' EXIT

health_file="${working_directory}/health.json"
health_status='000'
for attempt in {1..24}; do
  health_started="$(date +%s%3N)"
  health_status="$(curl --silent --show-error --connect-timeout 5 --max-time 10 --output "${health_file}" --write-out '%{http_code}' "${base_url}/health" || true)"
  health_duration="$(( $(date +%s%3N) - health_started ))"
  if [[ "${health_status}" == '200' ]] && validate_response health 200 "${health_status}" "${health_file}" "${health_duration}" >/dev/null 2>&1; then
    break
  fi
  [[ "${attempt}" -lt 24 ]] || fail 'web health did not become ready within two minutes'
  sleep 5
done

scenario_results='[]'
for scenario in happy slow-recommendation recommendation-error; do
  case "${scenario}" in
    happy)
      fault='none'
      expected_status='200'
      ;;
    slow-recommendation)
      fault='slow-recommendation'
      expected_status='200'
      ;;
    recommendation-error)
      fault='recommendation-error'
      expected_status='502'
      ;;
  esac

  trace_id="$(node -e "process.stdout.write(require('node:crypto').randomBytes(16).toString('hex'))")"
  parent_id="$(node -e "process.stdout.write(require('node:crypto').randomBytes(8).toString('hex'))")"
  correlation_id="integrated-demo-${scenario}-$(date +%s)"
  request_id="${correlation_id}-request"
  response_file="${working_directory}/${scenario}.json"
  request_body="$(jq -nc --arg fault "${fault}" '{movie_preference:"something exciting",seat_preference:"aisle",fault:$fault}')"

  started_at="$(date +%s%3N)"
  status="$(curl \
    --silent \
    --show-error \
    --connect-timeout 5 \
    --max-time 30 \
    --output "${response_file}" \
    --write-out '%{http_code}' \
    --header 'Content-Type: application/json' \
    --header "traceparent: 00-${trace_id}-${parent_id}-01" \
    --header "X-Correlation-Id: ${correlation_id}" \
    --header "X-Request-Id: ${request_id}" \
    --header "X-Demo-Fault: ${fault}" \
    --data "${request_body}" \
    "${base_url}/api/v1/demo/reserve-recommended-seat")" || fail "${scenario}: HTTP request failed"
  duration_ms="$(( $(date +%s%3N) - started_at ))"

  validate_response "${scenario}" "${expected_status}" "${status}" "${response_file}" "${duration_ms}" \
    || fail "${scenario}: response contract failed"

  observed_trace_id="$(jq -r '.trace.trace_id' "${response_file}")"
  scenario_results="$(jq -nc \
    --argjson results "${scenario_results}" \
    --arg scenario "${scenario}" \
    --arg status "${status}" \
    --arg trace_id "${observed_trace_id}" \
    --arg correlation_id "${correlation_id}" \
    --argjson duration_ms "${duration_ms}" \
    '$results + [{scenario:$scenario,http_status:($status|tonumber),duration_ms:$duration_ms,trace_id:$trace_id,correlation_id:$correlation_id}]')"
done

report="$(jq -nc \
  --arg result success \
  --arg target "${base_url}" \
  --argjson scenarios "${scenario_results}" \
  '{result:$result,target:$target,scenarios:$scenarios}')"

if [[ -n "${report_path}" ]]; then
  printf '%s\n' "${report}" >"${report_path}"
fi

printf '%s\n' "${report}"
printf 'Integrated demo smoke passed through the public web route\n'
