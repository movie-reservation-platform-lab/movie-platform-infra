#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
infra_directory="$(cd -- "${script_directory}/.." && pwd)"
collector_directory="${infra_directory}/adot-collector"
image_name="golden-path-adot-config-validation:local"
container_id=""

cleanup() {
  if [[ -n "${container_id}" ]]; then
    docker rm --force "${container_id}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

expected_base_image="public.ecr.aws/aws-observability/aws-otel-collector:v0.48.0@sha256:9b28046359054b414f4ba76056ba4e8cffda2d53fbcee06171d7eeecd71326c3"
if ! grep --fixed-strings --quiet "FROM ${expected_base_image}" "${collector_directory}/Dockerfile"; then
  printf 'ADOT Dockerfile is not pinned to the verified release and digest\n' >&2
  exit 1
fi

if grep --quiet '0\.0\.0\.0' "${collector_directory}/adot-config.yaml"; then
  printf 'ADOT receivers and diagnostics must remain bound to task loopback\n' >&2
  exit 1
fi
if ! grep --fixed-strings --quiet 'endpoint: 127.0.0.1:13133' "${collector_directory}/adot-config.yaml"; then
  printf 'ADOT health extension must remain bound to task loopback on port 13133\n' >&2
  exit 1
fi
if ! grep --fixed-strings --quiet 'endpoint: 127.0.0.1:4318' "${collector_directory}/adot-config.yaml"; then
  printf 'ADOT OTLP/HTTP receiver must remain bound to task loopback on port 4318\n' >&2
  exit 1
fi

pipeline_block="$(sed -n '/^  pipelines:/,$p' "${collector_directory}/adot-config.yaml")"
if ! grep --extended-regexp --quiet '^    traces:$' <<<"${pipeline_block}"; then
  printf 'ADOT config must contain the traces pipeline\n' >&2
  exit 1
fi
if ! grep --fixed-strings --quiet '    metrics/application/cloudwatch:' <<<"${pipeline_block}"; then
  printf 'ADOT config must contain the CloudWatch application metrics pipeline\n' >&2
  exit 1
fi
if ! grep --fixed-strings --quiet '    metrics/application/amp:' <<<"${pipeline_block}"; then
  printf 'ADOT config must contain the AMP application metrics pipeline\n' >&2
  exit 1
fi
if ! grep --fixed-strings --quiet '    metrics/ecs/amp:' <<<"${pipeline_block}"; then
  printf 'ADOT config must contain the AMP ECS metrics pipeline\n' >&2
  exit 1
fi
if grep --extended-regexp --quiet '^    logs([/:]|$)' <<<"${pipeline_block}"; then
  printf 'ADOT config must not contain a logs pipeline\n' >&2
  exit 1
fi
if ! grep --fixed-strings --quiet '  sigv4auth:' "${collector_directory}/adot-config.yaml"; then
  printf 'ADOT config must contain SigV4 authentication for AMP\n' >&2
  exit 1
fi
if ! grep --fixed-strings --quiet '  awsecscontainermetrics:' "${collector_directory}/adot-config.yaml"; then
  printf 'ADOT config must contain the ECS task/container metrics receiver\n' >&2
  exit 1
fi
if [[ "$(grep --fixed-strings --count '    add_metric_suffixes: false' \
  "${collector_directory}/adot-config.yaml")" -ne 2 ]]; then
  printf 'Both AMP exporters must preserve the repository metric-name contract\n' >&2
  exit 1
fi
if [[ "$(grep --fixed-strings --count '    target_info:' \
  "${collector_directory}/adot-config.yaml")" -ne 2 ]] ||
  [[ "$(grep --fixed-strings --count '      enabled: false' \
    "${collector_directory}/adot-config.yaml")" -lt 3 ]] ||
  [[ "$(grep --fixed-strings --count '    disable_scope_info: true' \
    "${collector_directory}/adot-config.yaml")" -ne 2 ]]; then
  printf 'AMP exporters must disable generated target/scope metadata series\n' >&2
  exit 1
fi
if grep --extended-regexp --quiet '^[[:space:]]+grpc:' "${collector_directory}/adot-config.yaml"; then
  printf 'ADOT receiver must expose OTLP/HTTP only\n' >&2
  exit 1
fi
if ! grep --fixed-strings --quiet '    index_all_attributes: false' "${collector_directory}/adot-config.yaml"; then
  printf 'ADOT X-Ray exporter must not index all span attributes\n' >&2
  exit 1
fi
if grep --extended-regexp --quiet '^[[:space:]]+indexed_attributes:' "${collector_directory}/adot-config.yaml"; then
  printf 'ADOT X-Ray exporter must not configure indexed attributes in this phase\n' >&2
  exit 1
fi
if ! grep --fixed-strings --quiet '    dimension_rollup_option: NoDimensionRollup' \
  "${collector_directory}/adot-config.yaml"; then
  printf 'ADOT CloudWatch metrics must disable automatic dimension rollups\n' >&2
  exit 1
fi
if [[ "$(grep --extended-regexp --count '^[[:space:]]+- \^.+\$$' "${collector_directory}/adot-config.yaml")" -ne 10 ]]; then
  printf 'ADOT CloudWatch metrics must declare exactly ten application instruments\n' >&2
  exit 1
fi

expected_ecs_metrics=(
  'ecs.task.cpu.reserved'
  'ecs.task.cpu.utilized'
  'ecs.task.memory.reserved'
  'ecs.task.memory.utilized'
  'container.cpu.reserved'
  'container.cpu.utilized'
  'container.memory.reserved'
  'container.memory.utilized'
)
for metric_name in "${expected_ecs_metrics[@]}"; do
  if [[ "$(grep --fixed-strings --count -- "- ${metric_name}" \
    "${collector_directory}/adot-config.yaml")" -ne 1 ]]; then
    printf 'ADOT ECS metric allowlist must contain exactly one %s entry\n' "${metric_name}" >&2
    exit 1
  fi
done

for forbidden_label in service.instance.id aws.ecs.task.arn aws.ecs.task.id container.id container.image.tag aws.ecs.container.image.id; do
  if ! grep --fixed-strings --quiet "      - key: ${forbidden_label}" "${collector_directory}/adot-config.yaml"; then
    printf 'ADOT AMP label policy must explicitly delete %s\n' "${forbidden_label}" >&2
    exit 1
  fi
done

if [[ "$(grep --fixed-strings --count '      queue_size: 256' \
  "${collector_directory}/adot-config.yaml")" -ne 2 ]]; then
  printf 'Both AMP exporters must use bounded remote-write queues\n' >&2
  exit 1
fi

docker build --pull --tag "${image_name}" "${collector_directory}"

# v0.48.0 has no standalone config-validation subcommand. Reaching the health
# extension proves that the pinned binary parsed the baked config and started
# every referenced receiver, processor, exporter, and extension.
container_id="$(docker run \
  --detach \
  --env AWS_ACCESS_KEY_ID=validation \
  --env AWS_SECRET_ACCESS_KEY=validation \
  --env AWS_EC2_METADATA_DISABLED=true \
  --env AWS_REGION=us-east-1 \
  --env AWS_STS_REGIONAL_ENDPOINTS=regional \
  --env AMP_REMOTE_WRITE_ENDPOINT=https://aps-workspaces.us-east-1.amazonaws.com/workspaces/ws-validation/api/v1/remote_write \
  --env APPLICATION_SERVICE_NAME=movie-reservation-service \
  --env CLOUDWATCH_METRICS_NAMESPACE=GoldenPath/test/movie-reservation-service \
  --env CLOUDWATCH_METRICS_LOG_GROUP_NAME=/golden-path/test/movie-reservation-service/metrics \
  --env DEPLOYMENT_ENVIRONMENT_NAME=test \
  --env ECS_CONTAINER_METADATA_URI_V4=http://127.0.0.1:1 \
  --env METRICS_COLLECTION_INTERVAL=30s \
  "${image_name}")"

for _ in {1..30}; do
  if docker exec "${container_id}" /healthcheck >/dev/null 2>&1; then
    printf 'ADOT image, X-Ray/CloudWatch/AMP/ECS config, and /healthcheck validated successfully\n'
    exit 0
  fi

  if [[ "$(docker inspect --format '{{.State.Running}}' "${container_id}" 2>/dev/null || true)" != "true" ]]; then
    printf 'ADOT collector exited before becoming healthy\n' >&2
    docker logs "${container_id}" >&2 || true
    exit 1
  fi

  sleep 1
done

printf 'ADOT collector did not become healthy within 30 seconds\n' >&2
docker logs "${container_id}" >&2 || true
exit 1
