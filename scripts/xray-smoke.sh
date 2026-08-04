#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: xray-smoke.sh [--stack STACK] [--base-url URL] [--report PATH]

Required environment:
  AWS_PROFILE   Explicit AWS CLI profile used for CloudFormation and X-Ray.
  AWS_REGION    AWS Region containing the deployed stack and X-Ray traces.

Optional environment:
  XRAY_SMOKE_TIMEOUT_SECONDS       Trace polling timeout (default: 60).
  XRAY_SMOKE_POLL_INTERVAL_SECONDS Poll interval (default: 5).
EOF
}

w3c_trace_id_to_xray() {
  local trace_id="${1:-}"
  if [[ ! "${trace_id}" =~ ^[0-9a-f]{32}$ || "${trace_id}" == "00000000000000000000000000000000" ]]; then
    return 1
  fi

  printf '1-%s-%s\n' "${trace_id:0:8}" "${trace_id:8:24}"
}

run_self_test() {
  local input_trace_id="4efaaf4d1e8720b39541901950019ee5"
  local expected_xray_id="1-4efaaf4d-1e8720b39541901950019ee5"
  local actual_xray_id
  actual_xray_id="$(w3c_trace_id_to_xray "${input_trace_id}")"

  [[ "${actual_xray_id}" == "${expected_xray_id}" ]]
  ! w3c_trace_id_to_xray "invalid" >/dev/null 2>&1
  ! w3c_trace_id_to_xray "00000000000000000000000000000000" >/dev/null 2>&1
  printf 'X-Ray smoke helper self-test passed\n'
}

if [[ "${1:-}" == '--self-test' ]]; then
  run_self_test
  exit 0
fi

stack_name="${STACK_NAME:-GoldenPathDemoStack}"
base_url="${XRAY_SMOKE_BASE_URL:-}"
report_path="${XRAY_SMOKE_REPORT_PATH:-}"
timeout_seconds="${XRAY_SMOKE_TIMEOUT_SECONDS:-60}"
poll_interval_seconds="${XRAY_SMOKE_POLL_INTERVAL_SECONDS:-5}"
result="failure"
failure_stage="prerequisites"
traceparent=""
xray_trace_id=""
correlation_id=""
request_id=""
target=""
started_at="$(node -e 'process.stdout.write(new Date().toISOString())')"
started_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
response_file=""
trace_file=""

emit_report() {
  local ended_at ended_ms duration_ms serialized_report
  ended_at="$(node -e 'process.stdout.write(new Date().toISOString())')"
  ended_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
  duration_ms="$((ended_ms - started_ms))"

  serialized_report="$(
    REPORT_RESULT="${result}" \
    REPORT_FAILURE_STAGE="${failure_stage}" \
    REPORT_TRACEPARENT="${traceparent}" \
    REPORT_XRAY_TRACE_ID="${xray_trace_id}" \
    REPORT_CORRELATION_ID="${correlation_id}" \
    REPORT_REQUEST_ID="${request_id}" \
    REPORT_STACK_NAME="${stack_name}" \
    REPORT_REGION="${AWS_REGION:-}" \
    REPORT_TARGET="${target}" \
    REPORT_STARTED_AT="${started_at}" \
    REPORT_ENDED_AT="${ended_at}" \
    REPORT_DURATION_MS="${duration_ms}" \
    node -e '
const report = {
  result: process.env.REPORT_RESULT,
  failure_stage: process.env.REPORT_FAILURE_STAGE || null,
  traceparent: process.env.REPORT_TRACEPARENT,
  xray_trace_id: process.env.REPORT_XRAY_TRACE_ID,
  correlation_id: process.env.REPORT_CORRELATION_ID,
  request_id: process.env.REPORT_REQUEST_ID,
  stack_name: process.env.REPORT_STACK_NAME,
  region: process.env.REPORT_REGION,
  target: process.env.REPORT_TARGET,
  started_at: process.env.REPORT_STARTED_AT,
  ended_at: process.env.REPORT_ENDED_AT,
  duration_ms: Number(process.env.REPORT_DURATION_MS),
};
process.stdout.write(JSON.stringify(report));
'
  )"
  printf '%s\n' "${serialized_report}"
  if [[ -n "${report_path}" ]]; then
    printf '%s\n' "${serialized_report}" >"${report_path}"
  fi
}

cleanup() {
  [[ -z "${response_file}" ]] || rm -f "${response_file}"
  [[ -z "${trace_file}" ]] || rm -f "${trace_file}"
}

on_exit() {
  local exit_code=$?
  trap - EXIT
  if [[ ${exit_code} -eq 0 ]]; then
    result="success"
    failure_stage=""
  fi
  emit_report || true
  cleanup
  exit "${exit_code}"
}
trap on_exit EXIT

fail() {
  failure_stage="$1"
  printf '%s\n' "$2" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stack)
      [[ $# -ge 2 ]] || fail prerequisites '--stack requires a value'
      stack_name="$2"
      shift 2
      ;;
    --base-url)
      [[ $# -ge 2 ]] || fail prerequisites '--base-url requires a value'
      base_url="$2"
      shift 2
      ;;
    --report)
      [[ $# -ge 2 ]] || fail prerequisites '--report requires a value'
      report_path="$2"
      shift 2
      ;;
    --help|-h)
      trap - EXIT
      usage
      cleanup
      exit 0
      ;;
    *)
      usage >&2
      fail prerequisites "unknown argument: $1"
      ;;
  esac
done

for required_command in aws curl node; do
  command -v "${required_command}" >/dev/null 2>&1 || fail prerequisites "missing required command: ${required_command}"
done

[[ -n "${AWS_PROFILE:-}" ]] || fail prerequisites 'AWS_PROFILE must be set explicitly'
[[ -n "${AWS_REGION:-}" ]] || fail prerequisites 'AWS_REGION must be set explicitly'
[[ "${stack_name}" =~ ^[A-Za-z][A-Za-z0-9-]{0,127}$ ]] || fail prerequisites 'stack name has an invalid format'
[[ "${timeout_seconds}" =~ ^[1-9][0-9]*$ ]] || fail prerequisites 'trace timeout must be a positive integer'
[[ "${poll_interval_seconds}" =~ ^[1-9][0-9]*$ ]] || fail prerequisites 'poll interval must be a positive integer'
if [[ -n "${report_path}" ]]; then
  report_directory="$(dirname -- "${report_path}")"
  if [[ ! -d "${report_directory}" || ! -w "${report_directory}" ]]; then
    report_path=''
    fail prerequisites 'report directory must exist and be writable'
  fi
  if [[ -e "${report_path}" && ( ! -f "${report_path}" || ! -w "${report_path}" ) ]]; then
    report_path=''
    fail prerequisites 'existing report path must be a writable regular file'
  fi
fi

if [[ -z "${base_url}" ]]; then
  if ! alb_dns_name="$(aws cloudformation describe-stacks \
    --stack-name "${stack_name}" \
    --profile "${AWS_PROFILE}" \
    --region "${AWS_REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='LoadBalancerDnsName'].OutputValue | [0]" \
    --output text)"; then
    fail stack_output 'failed to read the ALB DNS name from CloudFormation'
  fi
  [[ -n "${alb_dns_name}" && "${alb_dns_name}" != 'None' ]] || fail stack_output 'stack has no ALB DNS output'
  base_url="http://${alb_dns_name}"
fi

[[ "${base_url}" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?/?$ ]] || \
  fail prerequisites 'base URL must contain only an HTTP(S) host and optional port'
target="${base_url%/}"

trace_id="$(node -e "const c=require('node:crypto'); const t=Math.floor(Date.now()/1000).toString(16).padStart(8,'0'); process.stdout.write(t+c.randomBytes(12).toString('hex'))")"
parent_id="$(node -e "process.stdout.write(require('node:crypto').randomBytes(8).toString('hex'))")"
correlation_id="$(node -e "process.stdout.write(require('node:crypto').randomUUID())")"
request_id="$(node -e "process.stdout.write(require('node:crypto').randomUUID())")"
traceparent="00-${trace_id}-${parent_id}-01"
xray_trace_id="$(w3c_trace_id_to_xray "${trace_id}")"

response_file="$(mktemp)"
trace_file="$(mktemp)"
graphql_payload='{"operationName":"ObservabilitySmokeMovies","query":"query ObservabilitySmokeMovies { movies { id } }"}'

if ! http_status="$(curl --silent --show-error \
  --connect-timeout 10 \
  --max-time 30 \
  --output "${response_file}" \
  --write-out '%{http_code}' \
  --request POST \
  --header 'content-type: application/json' \
  --header "traceparent: ${traceparent}" \
  --header "X-Correlation-Id: ${correlation_id}" \
  --header "X-Request-Id: ${request_id}" \
  --data "${graphql_payload}" \
  "${target}/graphql")"; then
  fail http_request 'GraphQL HTTP request failed'
fi
[[ "${http_status}" =~ ^2[0-9]{2}$ ]] || fail http_request "GraphQL returned HTTP ${http_status}"

if ! node - "${response_file}" <<'NODE'
const fs = require('node:fs');
const response = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if ((Array.isArray(response.errors) && response.errors.length > 0) || !Array.isArray(response.data?.movies)) {
  process.exit(1);
}
NODE
then
  fail graphql_response 'GraphQL response contained errors or an unexpected data shape'
fi

failure_stage="xray_query"
deadline_ms="$(( $(node -e 'process.stdout.write(String(Date.now()))') + timeout_seconds * 1000 ))"
saw_trace_without_service='false'

while (( $(node -e 'process.stdout.write(String(Date.now()))') < deadline_ms )); do
  if ! aws xray batch-get-traces \
    --trace-ids "${xray_trace_id}" \
    --profile "${AWS_PROFILE}" \
    --region "${AWS_REGION}" \
    --output json >"${trace_file}"; then
    fail xray_query 'X-Ray BatchGetTraces failed'
  fi

  set +e
  node - "${trace_file}" <<'NODE'
const fs = require('node:fs');
const response = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const traces = Array.isArray(response.Traces) ? response.Traces : [];
if (traces.length === 0) process.exit(1);

for (const trace of traces) {
  for (const segment of Array.isArray(trace.Segments) ? trace.Segments : []) {
    try {
      if (JSON.parse(segment.Document).name === 'movie-reservation-service') process.exit(0);
    } catch {
      // A malformed segment is not proof of the expected service segment.
    }
  }
}
process.exit(2);
NODE
  trace_check_status=$?
  set -e

  if [[ ${trace_check_status} -eq 0 ]]; then
    exit 0
  fi
  if [[ ${trace_check_status} -eq 2 ]]; then
    saw_trace_without_service='true'
  fi

  sleep "${poll_interval_seconds}"
done

if [[ "${saw_trace_without_service}" == 'true' ]]; then
  fail service_segment_timeout 'X-Ray trace appeared without the expected service segment before timeout'
fi
fail trace_timeout 'X-Ray trace did not appear before timeout'
