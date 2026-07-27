#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: managed-metrics-smoke.sh [--stack STACK] [--base-url URL] [--report PATH]

Required environment:
  AWS_PROFILE   Explicit AWS CLI profile used for CloudFormation and CloudWatch.
  AWS_REGION    AWS Region containing the deployed stack and metrics.

Optional environment:
  MANAGED_METRICS_SMOKE_ATTEMPT_LIMIT                Reservation attempt limit (default: 12).
  MANAGED_METRICS_SMOKE_RESERVATION_TIMEOUT_SECONDS  Per-request terminal-status timeout (default: 20).
  MANAGED_METRICS_SMOKE_POLL_INTERVAL_SECONDS        Reservation polling interval (default: 1).
  MANAGED_METRICS_SMOKE_SETTLE_SECONDS               Wait before the CloudWatch query (default: 60).
  MANAGED_METRICS_SMOKE_METRIC_TIMEOUT_SECONDS       CloudWatch metric timeout (default: 180).
  MANAGED_METRICS_SMOKE_METRIC_POLL_SECONDS          CloudWatch polling interval (default: 10).
EOF
}

parse_catalog_targets() {
  node - "$1" <<'NODE'
const fs = require('node:fs');
const response = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (Array.isArray(response.errors) && response.errors.length > 0) process.exit(1);

const screenings = response.data?.screenings;
if (!Array.isArray(screenings)) process.exit(1);

const targets = [];
for (const screening of screenings) {
  if (typeof screening?.id !== 'string' || !Array.isArray(screening.seats)) continue;
  const seatIds = screening.seats
    .map((candidate) => candidate?.id)
    .filter((seatId) => typeof seatId === 'string' && seatId.length > 0);
  targets.push(...seatIds.map((seatId) => `${screening.id}\t${seatId}`));
}

if (targets.length === 0) process.exit(1);
process.stdout.write(`${targets.join('\n')}\n`);
NODE
}

parse_reservation_request_id() {
  node - "$1" <<'NODE'
const fs = require('node:fs');
const response = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (Array.isArray(response.errors) && response.errors.length > 0) process.exit(1);

const requestId = response.data?.requestReservation?.id;
if (typeof requestId !== 'string' || requestId.length === 0) process.exit(1);
process.stdout.write(`${requestId}\n`);
NODE
}

parse_reservation_status() {
  node - "$1" <<'NODE'
const fs = require('node:fs');
const response = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (Array.isArray(response.errors) && response.errors.length > 0) process.exit(1);

const status = response.data?.reservationRequestStatus?.status;
const allowedStatuses = new Set(['REQUESTED', 'PROCESSING', 'CONFIRMED', 'REJECTED', 'FAILED']);
if (!allowedStatuses.has(status)) process.exit(1);
process.stdout.write(`${status}\n`);
NODE
}

count_cloudwatch_datapoints() {
  node - "$1" <<'NODE'
const fs = require('node:fs');
const response = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const results = Array.isArray(response.MetricDataResults) ? response.MetricDataResults : [];
const count = results.reduce(
  (total, result) =>
    total + (Array.isArray(result.Values) ? result.Values.filter((value) => Number.isFinite(value)).length : 0),
  0,
);
process.stdout.write(`${count}\n`);
NODE
}

run_self_test() {
  local fixture_directory catalog_file request_file status_file metrics_file
  fixture_directory="$(mktemp -d)"
  catalog_file="${fixture_directory}/catalog.json"
  request_file="${fixture_directory}/request.json"
  status_file="${fixture_directory}/status.json"
  metrics_file="${fixture_directory}/metrics.json"

  printf '%s\n' \
    '{"data":{"screenings":[{"id":"screening-1","seats":[{"id":"seat-1"}]},{"id":"screening-2","seats":[{"id":"seat-2"}]}]}}' \
    >"${catalog_file}"
  printf '%s\n' '{"data":{"requestReservation":{"id":"request-1"}}}' >"${request_file}"
  printf '%s\n' '{"data":{"reservationRequestStatus":{"status":"CONFIRMED"}}}' >"${status_file}"
  printf '%s\n' '{"MetricDataResults":[{"Values":[2,1]},{"Values":[]}]}' >"${metrics_file}"

  [[ "$(parse_catalog_targets "${catalog_file}")" == $'screening-1\tseat-1\nscreening-2\tseat-2' ]]
  [[ "$(parse_reservation_request_id "${request_file}")" == 'request-1' ]]
  [[ "$(parse_reservation_status "${status_file}")" == 'CONFIRMED' ]]
  [[ "$(count_cloudwatch_datapoints "${metrics_file}")" == '2' ]]

  printf '%s\n' '{"data":{"screenings":[]}}' >"${catalog_file}"
  ! parse_catalog_targets "${catalog_file}" >/dev/null 2>&1

  rm -rf "${fixture_directory}"
  printf 'Managed metrics smoke helper self-test passed\n'
}

if [[ "${1:-}" == '--self-test' ]]; then
  run_self_test
  exit 0
fi

stack_name="${STACK_NAME:-GoldenPathDemoStack}"
base_url="${MANAGED_METRICS_SMOKE_BASE_URL:-}"
report_path="${MANAGED_METRICS_SMOKE_REPORT_PATH:-}"
attempt_limit="${MANAGED_METRICS_SMOKE_ATTEMPT_LIMIT:-12}"
reservation_timeout_seconds="${MANAGED_METRICS_SMOKE_RESERVATION_TIMEOUT_SECONDS:-20}"
poll_interval_seconds="${MANAGED_METRICS_SMOKE_POLL_INTERVAL_SECONDS:-1}"
settle_seconds="${MANAGED_METRICS_SMOKE_SETTLE_SECONDS:-60}"
metric_timeout_seconds="${MANAGED_METRICS_SMOKE_METRIC_TIMEOUT_SECONDS:-180}"
metric_poll_seconds="${MANAGED_METRICS_SMOKE_METRIC_POLL_SECONDS:-10}"
metric_name='graphql_operation_total'

result='failure'
failure_stage='prerequisites'
target=''
metrics_namespace=''
reservation_attempts=0
confirmed_outcomes=0
negative_outcomes=0
cloudwatch_datapoint_count=0
started_at="$(node -e 'process.stdout.write(new Date().toISOString())')"
started_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
temporary_directory=''

emit_report() {
  local ended_at ended_ms duration_ms
  ended_at="$(node -e 'process.stdout.write(new Date().toISOString())')"
  ended_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
  duration_ms="$((ended_ms - started_ms))"

  REPORT_RESULT="${result}" \
    REPORT_FAILURE_STAGE="${failure_stage}" \
    REPORT_STACK_NAME="${stack_name}" \
    REPORT_REGION="${AWS_REGION:-}" \
    REPORT_TARGET="${target}" \
    REPORT_METRICS_NAMESPACE="${metrics_namespace}" \
    REPORT_METRIC_NAME="${metric_name}" \
    REPORT_RESERVATION_ATTEMPTS="${reservation_attempts}" \
    REPORT_CONFIRMED_OUTCOMES="${confirmed_outcomes}" \
    REPORT_NEGATIVE_OUTCOMES="${negative_outcomes}" \
    REPORT_CLOUDWATCH_DATAPOINT_COUNT="${cloudwatch_datapoint_count}" \
    REPORT_STARTED_AT="${started_at}" \
    REPORT_ENDED_AT="${ended_at}" \
    REPORT_DURATION_MS="${duration_ms}" \
    REPORT_PATH="${report_path}" \
    node -e '
const fs = require("node:fs");
const report = {
  result: process.env.REPORT_RESULT,
  failure_stage: process.env.REPORT_FAILURE_STAGE || null,
  stack_name: process.env.REPORT_STACK_NAME,
  region: process.env.REPORT_REGION,
  target: process.env.REPORT_TARGET,
  metrics_namespace: process.env.REPORT_METRICS_NAMESPACE,
  metric_name: process.env.REPORT_METRIC_NAME,
  reservation_attempts: Number(process.env.REPORT_RESERVATION_ATTEMPTS),
  confirmed_outcomes: Number(process.env.REPORT_CONFIRMED_OUTCOMES),
  negative_outcomes: Number(process.env.REPORT_NEGATIVE_OUTCOMES),
  cloudwatch_datapoint_count: Number(process.env.REPORT_CLOUDWATCH_DATAPOINT_COUNT),
  started_at: process.env.REPORT_STARTED_AT,
  ended_at: process.env.REPORT_ENDED_AT,
  duration_ms: Number(process.env.REPORT_DURATION_MS),
};
const serializedReport = `${JSON.stringify(report)}\n`;
process.stdout.write(serializedReport);
if (process.env.REPORT_PATH) {
  fs.writeFileSync(process.env.REPORT_PATH, serializedReport, { encoding: "utf8", flag: "w" });
}
'
}

cleanup() {
  [[ -z "${temporary_directory}" ]] || rm -rf "${temporary_directory}"
}

on_exit() {
  local exit_code=$?
  trap - EXIT
  if [[ ${exit_code} -eq 0 ]]; then
    result='success'
    failure_stage=''
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
[[ "${attempt_limit}" =~ ^[1-9][0-9]*$ ]] || fail prerequisites 'attempt limit must be a positive integer'
[[ "${reservation_timeout_seconds}" =~ ^[1-9][0-9]*$ ]] || \
  fail prerequisites 'reservation timeout must be a positive integer'
[[ "${poll_interval_seconds}" =~ ^[1-9][0-9]*$ ]] || \
  fail prerequisites 'reservation poll interval must be a positive integer'
[[ "${settle_seconds}" =~ ^[0-9]+$ ]] || fail prerequisites 'settle time must be a nonnegative integer'
[[ "${metric_timeout_seconds}" =~ ^[1-9][0-9]*$ ]] || \
  fail prerequisites 'metric timeout must be a positive integer'
[[ "${metric_poll_seconds}" =~ ^[1-9][0-9]*$ ]] || \
  fail prerequisites 'metric poll interval must be a positive integer'

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

temporary_directory="$(mktemp -d)"
stack_outputs_file="${temporary_directory}/stack-outputs.json"
response_file="${temporary_directory}/graphql-response.json"
cloudwatch_file="${temporary_directory}/cloudwatch-metrics.json"

if ! aws cloudformation describe-stacks \
  --stack-name "${stack_name}" \
  --profile "${AWS_PROFILE}" \
  --region "${AWS_REGION}" \
  --query 'Stacks[0].Outputs' \
  --output json >"${stack_outputs_file}"; then
  fail stack_output 'failed to read CloudFormation stack outputs'
fi

read_stack_output() {
  node - "$stack_outputs_file" "$1" <<'NODE'
const fs = require('node:fs');
const outputs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const outputKey = process.argv[3];
const match = Array.isArray(outputs) ? outputs.find((output) => output?.OutputKey === outputKey) : undefined;
if (typeof match?.OutputValue !== 'string' || match.OutputValue.length === 0) process.exit(1);
process.stdout.write(`${match.OutputValue}\n`);
NODE
}

if ! metrics_namespace="$(read_stack_output 'CloudWatchApplicationMetricsNamespace')"; then
  fail stack_output 'stack has no CloudWatch application metrics namespace output'
fi

if [[ -z "${base_url}" ]]; then
  if ! alb_dns_name="$(read_stack_output 'LoadBalancerDnsName')"; then
    fail stack_output 'stack has no ALB DNS output'
  fi
  base_url="http://${alb_dns_name}"
fi

[[ "${base_url}" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?/?$ ]] || \
  fail prerequisites 'base URL must contain only an HTTP(S) host and optional port'
target="${base_url%/}"

post_graphql() {
  local payload="$1"
  local stage="$2"
  local http_status

  if ! http_status="$(curl --silent --show-error \
    --connect-timeout 10 \
    --max-time 30 \
    --output "${response_file}" \
    --write-out '%{http_code}' \
    --request POST \
    --header 'content-type: application/json' \
    --data "${payload}" \
    "${target}/graphql")"; then
    fail "${stage}" 'GraphQL HTTP request failed'
  fi

  [[ "${http_status}" =~ ^2[0-9]{2}$ ]] || fail "${stage}" "GraphQL returned HTTP ${http_status}"
}

catalog_payload='{"operationName":"ManagedMetricsSmokeCatalog","query":"query ManagedMetricsSmokeCatalog { screenings { id seats { id } } }"}'
post_graphql "${catalog_payload}" catalog

if ! catalog_output="$(parse_catalog_targets "${response_file}")"; then
  fail catalog 'GraphQL catalog response had no screening with a seat'
fi
catalog_targets=()
while IFS= read -r catalog_target; do
  [[ -z "${catalog_target}" ]] || catalog_targets+=("${catalog_target}")
done <<<"${catalog_output}"
(( ${#catalog_targets[@]} > 0 )) || fail catalog 'GraphQL catalog response had no screening with a seat'

confirmed_target=''
for ((attempt = 1; attempt <= attempt_limit; attempt += 1)); do
  reservation_attempts="${attempt}"
  if [[ -n "${confirmed_target}" ]]; then
    catalog_target="${confirmed_target}"
  else
    catalog_target_index="$(((attempt - 1) % ${#catalog_targets[@]}))"
    catalog_target="${catalog_targets[${catalog_target_index}]}"
  fi
  IFS=$'\t' read -r screening_id seat_id <<<"${catalog_target}"

  request_payload="$(
    node - "${screening_id}" "${seat_id}" <<'NODE'
const payload = {
  operationName: 'ManagedMetricsSmokeRequestReservation',
  query: `mutation ManagedMetricsSmokeRequestReservation($input: RequestReservationInput!) {
    requestReservation(input: $input) { id status }
  }`,
  variables: {
    input: {
      screeningId: process.argv[2],
      seatIds: [process.argv[3]],
    },
  },
};
process.stdout.write(JSON.stringify(payload));
NODE
  )"
  post_graphql "${request_payload}" reservation_request

  if ! reservation_request_id="$(parse_reservation_request_id "${response_file}")"; then
    fail reservation_request 'GraphQL reservation mutation returned an unexpected response'
  fi

  status_payload="$(
    node - "${reservation_request_id}" <<'NODE'
const payload = {
  operationName: 'ManagedMetricsSmokeReservationStatus',
  query: `query ManagedMetricsSmokeReservationStatus($id: ID!) {
    reservationRequestStatus(id: $id) { status }
  }`,
  variables: { id: process.argv[2] },
};
process.stdout.write(JSON.stringify(payload));
NODE
  )"

  terminal_status=''
  status_deadline="$((SECONDS + reservation_timeout_seconds))"
  while ((SECONDS < status_deadline)); do
    post_graphql "${status_payload}" reservation_status
    if ! current_status="$(parse_reservation_status "${response_file}")"; then
      fail reservation_status 'GraphQL reservation status returned an unexpected response'
    fi

    case "${current_status}" in
      CONFIRMED|REJECTED|FAILED)
        terminal_status="${current_status}"
        break
        ;;
      REQUESTED|PROCESSING)
        sleep "${poll_interval_seconds}"
        ;;
    esac
  done

  [[ -n "${terminal_status}" ]] || fail reservation_status 'reservation request did not reach a terminal status'

  if [[ "${terminal_status}" == 'CONFIRMED' ]]; then
    confirmed_outcomes="$((confirmed_outcomes + 1))"
    confirmed_target="${catalog_target}"
  else
    negative_outcomes="$((negative_outcomes + 1))"
  fi

  if ((confirmed_outcomes > 0 && negative_outcomes > 0)); then
    break
  fi
done

if ((confirmed_outcomes == 0 || negative_outcomes == 0)); then
  fail reservation_outcomes \
    "bounded traffic did not produce both confirmed and failed/rejected outcomes after ${attempt_limit} attempts"
fi

if ((settle_seconds > 0)); then
  printf 'Waiting %s seconds for two default metric export intervals...\n' "${settle_seconds}" >&2
  sleep "${settle_seconds}"
fi

metric_query_json="$(
  node - "${metrics_namespace}" "${metric_name}" <<'NODE'
const namespace = process.argv[2];
const metricName = process.argv[3];
const expression = `SEARCH('{${namespace}} MetricName="${metricName}"', 'Sum', 60)`;
process.stdout.write(JSON.stringify([{ Id: 'applicationMetrics', Expression: expression, ReturnData: true }]));
NODE
)"

failure_stage='cloudwatch_metric'
metric_deadline="$((SECONDS + metric_timeout_seconds))"
metric_start_time="$(
  node -e 'process.stdout.write(new Date(Number(process.argv[1]) - 60 * 1000).toISOString())' "${started_ms}"
)"

while ((SECONDS < metric_deadline)); do
  metric_end_time="$(node -e 'process.stdout.write(new Date().toISOString())')"
  if ! aws cloudwatch get-metric-data \
    --metric-data-queries "${metric_query_json}" \
    --start-time "${metric_start_time}" \
    --end-time "${metric_end_time}" \
    --scan-by TimestampDescending \
    --max-datapoints 100 \
    --profile "${AWS_PROFILE}" \
    --region "${AWS_REGION}" \
    --output json >"${cloudwatch_file}"; then
    fail cloudwatch_query 'CloudWatch GetMetricData failed'
  fi

  if ! cloudwatch_datapoint_count="$(count_cloudwatch_datapoints "${cloudwatch_file}")"; then
    fail cloudwatch_query 'CloudWatch returned an unexpected metric response'
  fi

  if ((cloudwatch_datapoint_count > 0)); then
    exit 0
  fi

  sleep "${metric_poll_seconds}"
done

fail cloudwatch_metric "CloudWatch metric ${metric_name} did not contain datapoints before timeout"
