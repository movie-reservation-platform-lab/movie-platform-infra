#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: managed-metrics-smoke.sh [--stack STACK] [--base-url URL] [--report PATH]

Required environment:
  AWS_PROFILE   Explicit AWS profile used by the AWS CLI and awscurl.
  AWS_REGION    AWS Region containing the deployed stack, CloudWatch, and AMP.

Optional environment:
  MANAGED_METRICS_SMOKE_ATTEMPT_LIMIT                Reservation attempt limit (default: 12).
  MANAGED_METRICS_SMOKE_RESERVATION_TIMEOUT_SECONDS  Per-request terminal-status timeout (default: 20).
  MANAGED_METRICS_SMOKE_POLL_INTERVAL_SECONDS        Reservation polling interval (default: 1).
  MANAGED_METRICS_SMOKE_SETTLE_SECONDS               Wait before metric queries (default: 60).
  MANAGED_METRICS_SMOKE_METRIC_TIMEOUT_SECONDS       Timeout for each metric backend (default: 180).
  MANAGED_METRICS_SMOKE_METRIC_POLL_SECONDS          Metric polling interval (default: 10).
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

count_cloudwatch_datapoints_for_id() {
  node - "$1" "$2" <<'NODE'
const fs = require('node:fs');
const response = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const results = Array.isArray(response.MetricDataResults) ? response.MetricDataResults : [];
const result = results.find((candidate) => candidate?.Id === process.argv[3]);
if (result === undefined) process.exit(1);
const count = Array.isArray(result.Values)
  ? result.Values.filter((value) => Number.isFinite(value)).length
  : 0;
process.stdout.write(`${count}\n`);
NODE
}

summarize_amp_metrics() {
  node - "$1" <<'NODE'
const fs = require('node:fs');
const response = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (response.status !== 'success' || !Array.isArray(response.data?.result)) process.exit(1);

const applicationMetric = 'graphql_operation_total';
const taskMetrics = new Set([
  'ecs_task_cpu_reserved',
  'ecs_task_cpu_utilized',
  'ecs_task_memory_reserved',
  'ecs_task_memory_utilized',
]);
const containerMetrics = new Set([
  'container_cpu_reserved',
  'container_cpu_utilized',
  'container_memory_reserved',
  'container_memory_utilized',
]);
const requiredMetrics = new Set([applicationMetric, ...taskMetrics, ...containerMetrics]);
const forbiddenGeneratedMetrics = new Set(['target_info', 'otel_scope_info']);
const forbiddenCommonLabels = new Set(['instance', 'service_instance_id']);
const requiredTaskLabels = [
  'aws_ecs_cluster_name',
  'aws_ecs_service_name',
  'aws_ecs_task_family',
  'cloud_region',
];
const forbiddenEcsLabels = new Set([
  'aws_ecs_task_arn',
  'aws_ecs_task_id',
  'aws_ecs_task_version',
  'cloud_zone',
  'cloud_account_id',
  'aws_ecs_task_pull_started_at',
  'aws_ecs_task_pull_stopped_at',
  'aws_ecs_task_known_status',
  'aws_ecs_task_launch_type',
  'aws_ecs_container_created_at',
  'aws_ecs_container_finished_at',
  'aws_ecs_container_known_status',
  'aws_ecs_container_know_status',
  'aws_ecs_container_exit_code',
  'container_id',
  'aws_ecs_docker_name',
  'container_image_name',
  'container_image_tag',
  'container_image_id',
  'aws_ecs_container_image_id',
]);

const seenMetrics = new Set();
let applicationSeriesCount = 0;
let taskSeriesCount = 0;
let containerSeriesCount = 0;

for (const result of response.data.result) {
  const labels = result?.metric;
  if (labels === null || typeof labels !== 'object' || Array.isArray(labels)) process.exit(1);
  const metricName = labels.__name__;
  if (forbiddenGeneratedMetrics.has(metricName)) process.exit(1);
  if (!requiredMetrics.has(metricName)) continue;
  if (Object.keys(labels).some((labelName) => forbiddenCommonLabels.has(labelName))) process.exit(1);

  seenMetrics.add(metricName);
  if (metricName === applicationMetric) {
    if (
      typeof labels.service_name !== 'string' ||
      labels.service_name.length === 0 ||
      typeof labels.deployment_environment !== 'string' ||
      labels.deployment_environment.length === 0
    ) {
      process.exit(1);
    }
    applicationSeriesCount += 1;
    continue;
  }

  if (
    requiredTaskLabels.some(
      (labelName) => typeof labels[labelName] !== 'string' || labels[labelName].length === 0,
    )
  ) {
    process.exit(1);
  }
  if (Object.keys(labels).some((labelName) => forbiddenEcsLabels.has(labelName))) process.exit(1);

  if (taskMetrics.has(metricName)) {
    taskSeriesCount += 1;
  } else {
    if (typeof labels.container_name !== 'string' || labels.container_name.length === 0) process.exit(1);
    containerSeriesCount += 1;
  }
}

const isComplete = [...requiredMetrics].every((metricName) => seenMetrics.has(metricName));
process.stdout.write(
  `${isComplete ? 1 : 0}\t${applicationSeriesCount}\t${taskSeriesCount}\t${containerSeriesCount}\n`,
);
NODE
}

run_self_test() {
  local fixture_directory catalog_file request_file status_file metrics_file amp_file
  fixture_directory="$(mktemp -d)"
  catalog_file="${fixture_directory}/catalog.json"
  request_file="${fixture_directory}/request.json"
  status_file="${fixture_directory}/status.json"
  metrics_file="${fixture_directory}/metrics.json"
  amp_file="${fixture_directory}/amp.json"

  printf '%s\n' \
    '{"data":{"screenings":[{"id":"screening-1","seats":[{"id":"seat-1"}]},{"id":"screening-2","seats":[{"id":"seat-2"}]}]}}' \
    >"${catalog_file}"
  printf '%s\n' '{"data":{"requestReservation":{"id":"request-1"}}}' >"${request_file}"
  printf '%s\n' '{"data":{"reservationRequestStatus":{"status":"CONFIRMED"}}}' >"${status_file}"
  printf '%s\n' '{"MetricDataResults":[{"Id":"applicationMetrics","Values":[2,1]},{"Id":"other","Values":[]}]}' \
    >"${metrics_file}"
  printf '%s\n' \
    '{"status":"success","data":{"result":[{"metric":{"__name__":"graphql_operation_total","service_name":"movie-reservation-service","deployment_environment":"aws-demo"}},{"metric":{"__name__":"ecs_task_cpu_reserved","aws_ecs_cluster_name":"cluster","aws_ecs_service_name":"service","aws_ecs_task_family":"family","cloud_region":"eu-central-1"}},{"metric":{"__name__":"ecs_task_cpu_utilized","aws_ecs_cluster_name":"cluster","aws_ecs_service_name":"service","aws_ecs_task_family":"family","cloud_region":"eu-central-1"}},{"metric":{"__name__":"ecs_task_memory_reserved","aws_ecs_cluster_name":"cluster","aws_ecs_service_name":"service","aws_ecs_task_family":"family","cloud_region":"eu-central-1"}},{"metric":{"__name__":"ecs_task_memory_utilized","aws_ecs_cluster_name":"cluster","aws_ecs_service_name":"service","aws_ecs_task_family":"family","cloud_region":"eu-central-1"}},{"metric":{"__name__":"container_cpu_reserved","aws_ecs_cluster_name":"cluster","aws_ecs_service_name":"service","aws_ecs_task_family":"family","cloud_region":"eu-central-1","container_name":"app"}},{"metric":{"__name__":"container_cpu_utilized","aws_ecs_cluster_name":"cluster","aws_ecs_service_name":"service","aws_ecs_task_family":"family","cloud_region":"eu-central-1","container_name":"app"}},{"metric":{"__name__":"container_memory_reserved","aws_ecs_cluster_name":"cluster","aws_ecs_service_name":"service","aws_ecs_task_family":"family","cloud_region":"eu-central-1","container_name":"app"}},{"metric":{"__name__":"container_memory_utilized","aws_ecs_cluster_name":"cluster","aws_ecs_service_name":"service","aws_ecs_task_family":"family","cloud_region":"eu-central-1","container_name":"app"}}]}}' \
    >"${amp_file}"

  [[ "$(parse_catalog_targets "${catalog_file}")" == $'screening-1\tseat-1\nscreening-2\tseat-2' ]]
  [[ "$(parse_reservation_request_id "${request_file}")" == 'request-1' ]]
  [[ "$(parse_reservation_status "${status_file}")" == 'CONFIRMED' ]]
  [[ "$(count_cloudwatch_datapoints_for_id "${metrics_file}" 'applicationMetrics')" == '2' ]]
  [[ "$(summarize_amp_metrics "${amp_file}")" == $'1\t1\t4\t4' ]]

  printf '%s\n' '{"data":{"screenings":[]}}' >"${catalog_file}"
  ! parse_catalog_targets "${catalog_file}" >/dev/null 2>&1
  printf '%s\n' \
    '{"status":"success","data":{"result":[{"metric":{"__name__":"ecs_task_cpu_reserved","aws_ecs_cluster_name":"cluster","aws_ecs_service_name":"service","aws_ecs_task_family":"family","cloud_region":"eu-central-1","aws_ecs_task_id":"churn"}}]}}' \
    >"${amp_file}"
  ! summarize_amp_metrics "${amp_file}" >/dev/null 2>&1

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
amp_prometheus_endpoint=''
ecs_cluster_name=''
ecs_service_name=''
reservation_attempts=0
confirmed_outcomes=0
negative_outcomes=0
cloudwatch_datapoint_count=0
amp_application_series_count=0
amp_ecs_task_series_count=0
amp_container_series_count=0
container_insights_task_datapoint_count=0
container_insights_container_datapoint_count=0
started_at="$(node -e 'process.stdout.write(new Date().toISOString())')"
started_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
temporary_directory=''

emit_report() {
  local ended_at ended_ms duration_ms serialized_report
  ended_at="$(node -e 'process.stdout.write(new Date().toISOString())')"
  ended_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
  duration_ms="$((ended_ms - started_ms))"

  serialized_report="$(
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
    REPORT_AMP_APPLICATION_SERIES_COUNT="${amp_application_series_count}" \
    REPORT_AMP_ECS_TASK_SERIES_COUNT="${amp_ecs_task_series_count}" \
    REPORT_AMP_CONTAINER_SERIES_COUNT="${amp_container_series_count}" \
    REPORT_CONTAINER_INSIGHTS_TASK_DATAPOINT_COUNT="${container_insights_task_datapoint_count}" \
    REPORT_CONTAINER_INSIGHTS_CONTAINER_DATAPOINT_COUNT="${container_insights_container_datapoint_count}" \
    REPORT_STARTED_AT="${started_at}" \
    REPORT_ENDED_AT="${ended_at}" \
    REPORT_DURATION_MS="${duration_ms}" \
    node -e '
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
  amp_application_series_count: Number(process.env.REPORT_AMP_APPLICATION_SERIES_COUNT),
  amp_ecs_task_series_count: Number(process.env.REPORT_AMP_ECS_TASK_SERIES_COUNT),
  amp_container_series_count: Number(process.env.REPORT_AMP_CONTAINER_SERIES_COUNT),
  container_insights_task_datapoint_count: Number(
    process.env.REPORT_CONTAINER_INSIGHTS_TASK_DATAPOINT_COUNT,
  ),
  container_insights_container_datapoint_count: Number(
    process.env.REPORT_CONTAINER_INSIGHTS_CONTAINER_DATAPOINT_COUNT,
  ),
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

for required_command in aws awscurl curl node; do
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
amp_file="${temporary_directory}/amp-metrics.json"
container_insights_file="${temporary_directory}/container-insights-metrics.json"

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

if ! amp_prometheus_endpoint="$(read_stack_output 'AmpPrometheusEndpoint')"; then
  fail stack_output 'stack has no AMP Prometheus endpoint output'
fi

if ! ecs_cluster_name="$(read_stack_output 'EcsClusterName')"; then
  fail stack_output 'stack has no ECS cluster name output'
fi

if ! ecs_service_name="$(read_stack_output 'EcsServiceName')"; then
  fail stack_output 'stack has no ECS service name output'
fi

if ! amp_query_endpoint="$(
  node - "${amp_prometheus_endpoint}" <<'NODE'
const endpoint = new URL(process.argv[2]);
if (
  endpoint.protocol !== 'https:' ||
  endpoint.username.length > 0 ||
  endpoint.password.length > 0 ||
  endpoint.search.length > 0 ||
  endpoint.hash.length > 0 ||
  !endpoint.pathname.endsWith('/api/v1/')
) {
  process.exit(1);
}
endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/query`;
process.stdout.write(endpoint.toString());
NODE
)"; then
  fail stack_output 'stack AMP Prometheus endpoint has an unexpected format'
fi

[[ "${ecs_cluster_name}" =~ ^[A-Za-z0-9_-]+$ ]] || \
  fail stack_output 'stack ECS cluster name has an unexpected format'
[[ "${ecs_service_name}" =~ ^[A-Za-z0-9_-]+$ ]] || \
  fail stack_output 'stack ECS service name has an unexpected format'

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

while true; do
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

  if ! cloudwatch_datapoint_count="$(
    count_cloudwatch_datapoints_for_id "${cloudwatch_file}" 'applicationMetrics'
  )"; then
    fail cloudwatch_query 'CloudWatch returned an unexpected metric response'
  fi

  if ((cloudwatch_datapoint_count > 0)); then
    break
  fi

  ((SECONDS < metric_deadline)) || break
  sleep "${metric_poll_seconds}"
done

if ((cloudwatch_datapoint_count == 0)); then
  fail cloudwatch_metric "CloudWatch metric ${metric_name} did not contain datapoints before timeout"
fi

amp_promql='{
  __name__=~"graphql_operation_total|ecs_task_(cpu|memory)_(reserved|utilized)|container_(cpu|memory)_(reserved|utilized)|target_info|otel_scope_info"
}'
amp_query_form="$(
  node - "${amp_promql}" <<'NODE'
const form = new URLSearchParams({ query: process.argv[2] });
process.stdout.write(form.toString());
NODE
)"

failure_stage='amp_metric'
metric_deadline="$((SECONDS + metric_timeout_seconds))"
amp_complete=0

while true; do
  if ! awscurl \
    --profile "${AWS_PROFILE}" \
    --region "${AWS_REGION}" \
    --service aps \
    -X POST \
    --header 'Content-Type: application/x-www-form-urlencoded' \
    -d "${amp_query_form}" \
    "${amp_query_endpoint}" >"${amp_file}"; then
    fail amp_query 'AMP Prometheus query failed'
  fi

  if ! amp_summary="$(summarize_amp_metrics "${amp_file}")"; then
    fail amp_contract 'AMP returned an unexpected response or violated the metric label contract'
  fi
  IFS=$'\t' read -r \
    amp_complete \
    amp_application_series_count \
    amp_ecs_task_series_count \
    amp_container_series_count <<<"${amp_summary}"

  if ((amp_complete == 1)); then
    break
  fi

  ((SECONDS < metric_deadline)) || break
  sleep "${metric_poll_seconds}"
done

if ((amp_complete == 0)); then
  fail amp_metric 'AMP did not contain the application metric and all eight ECS metrics before timeout'
fi

container_insights_query_json="$(
  node - "${ecs_cluster_name}" "${ecs_service_name}" <<'NODE'
const clusterName = process.argv[2];
const serviceName = process.argv[3];
const dimension = (Name, Value) => ({ Name, Value });
const taskDimensions = [
  dimension('ClusterName', clusterName),
  dimension('ServiceName', serviceName),
];
const containerDimensions = [
  ...taskDimensions,
  dimension('ContainerName', serviceName),
];
const query = (id, metricName, dimensions) => ({
  Id: id,
  MetricStat: {
    Metric: {
      Namespace: 'ECS/ContainerInsights',
      MetricName: metricName,
      Dimensions: dimensions,
    },
    Period: 60,
    Stat: 'Average',
  },
  ReturnData: true,
});
process.stdout.write(
  JSON.stringify([
    query('taskCpu', 'TaskCpuUtilization', taskDimensions),
    query('taskMemory', 'TaskMemoryUtilization', taskDimensions),
    query('containerCpu', 'ContainerCpuUtilization', containerDimensions),
    query('containerMemory', 'ContainerMemoryUtilization', containerDimensions),
  ]),
);
NODE
)"

failure_stage='container_insights_metric'
metric_deadline="$((SECONDS + metric_timeout_seconds))"
task_cpu_datapoints=0
task_memory_datapoints=0
container_cpu_datapoints=0
container_memory_datapoints=0

while true; do
  metric_end_time="$(node -e 'process.stdout.write(new Date().toISOString())')"
  if ! aws cloudwatch get-metric-data \
    --metric-data-queries "${container_insights_query_json}" \
    --start-time "${metric_start_time}" \
    --end-time "${metric_end_time}" \
    --scan-by TimestampDescending \
    --max-datapoints 100 \
    --profile "${AWS_PROFILE}" \
    --region "${AWS_REGION}" \
    --output json >"${container_insights_file}"; then
    fail container_insights_query 'CloudWatch Container Insights query failed'
  fi

  if ! task_cpu_datapoints="$(
    count_cloudwatch_datapoints_for_id "${container_insights_file}" 'taskCpu'
  )" ||
    ! task_memory_datapoints="$(
      count_cloudwatch_datapoints_for_id "${container_insights_file}" 'taskMemory'
    )" ||
    ! container_cpu_datapoints="$(
      count_cloudwatch_datapoints_for_id "${container_insights_file}" 'containerCpu'
    )" ||
    ! container_memory_datapoints="$(
      count_cloudwatch_datapoints_for_id "${container_insights_file}" 'containerMemory'
    )"; then
    fail container_insights_query 'CloudWatch returned an unexpected Container Insights response'
  fi

  container_insights_task_datapoint_count="$((task_cpu_datapoints + task_memory_datapoints))"
  container_insights_container_datapoint_count="$((container_cpu_datapoints + container_memory_datapoints))"

  if ((
    task_cpu_datapoints > 0 &&
      task_memory_datapoints > 0 &&
      container_cpu_datapoints > 0 &&
      container_memory_datapoints > 0
  )); then
    exit 0
  fi

  ((SECONDS < metric_deadline)) || break
  sleep "${metric_poll_seconds}"
done

fail container_insights_metric \
  'CloudWatch did not contain all four enhanced Container Insights metrics before timeout'
