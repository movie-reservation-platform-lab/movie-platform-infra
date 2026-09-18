#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
tempo_container=""
collector_container=""
cleanup() {
  if [[ -n "$collector_container" ]]; then docker rm -f "$collector_container" >/dev/null; fi
  if [[ -n "$tempo_container" ]]; then docker rm -f "$tempo_container" >/dev/null; fi
}
trap cleanup EXIT
docker build -t movie-platform-tempo-validation:local "$repo_dir/tempo"
tempo_container="$(docker run --detach --network none --user 10001 \
  --env AWS_ACCESS_KEY_ID=validation --env AWS_SECRET_ACCESS_KEY=validation \
  --env AWS_EC2_METADATA_DISABLED=true --env AWS_REGION=us-east-1 \
  --env AWS_STS_REGIONAL_ENDPOINTS=regional \
  --env AMP_REMOTE_WRITE_ENDPOINT=http://127.0.0.1:1/api/v1/remote_write \
  movie-platform-tempo-validation:local)"
for attempt in {1..60}; do
  if docker exec "$tempo_container" /busybox wget -q -T 3 -O /dev/null http://127.0.0.1:3200/ready; then
    printf 'Pinned Tempo image parsed its configuration and passed /ready as non-root.\n'
    break
  fi
  if [[ "$(docker inspect -f '{{.State.Running}}' "$tempo_container")" != true ]]; then
    docker logs "$tempo_container" >&2
    exit 1
  fi
  sleep 1
done
docker exec "$tempo_container" /busybox wget -q -T 3 -O /dev/null http://127.0.0.1:3200/ready
docker build -t movie-platform-adot-tempo-validation:local "$repo_dir/adot-collector"
collector_container="$(docker run --detach --network "container:$tempo_container" \
  --env AWS_ACCESS_KEY_ID=validation --env AWS_SECRET_ACCESS_KEY=validation \
  --env AWS_EC2_METADATA_DISABLED=true --env AWS_REGION=us-east-1 \
  --env AWS_STS_REGIONAL_ENDPOINTS=regional \
  --env AMP_REMOTE_WRITE_ENDPOINT=http://127.0.0.1:1 \
  --env CLOUDWATCH_METRICS_NAMESPACE=Validation \
  --env CLOUDWATCH_METRICS_LOG_GROUP_NAME=/validation \
  --env DEPLOYMENT_ENVIRONMENT_NAME=test --env METRICS_COLLECTION_INTERVAL=30s \
  --env ECS_CONTAINER_METADATA_URI_V4=http://127.0.0.1:1 \
  --env TEMPO_OTLP_ENDPOINT=127.0.0.1:4317 \
  movie-platform-adot-tempo-validation:local \
  --config=/etc/adot/adot-config.yaml --config=/etc/adot/tempo-overlay.yaml)"
for attempt in {1..30}; do
  if docker exec "$collector_container" /healthcheck >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$collector_container" /healthcheck
trace_id=1234567890abcdef1234567890abcdef
start_ns="$(date +%s)000000000"
end_ns="$((start_ns + 1000000))"
payload="{\"resourceSpans\":[{\"resource\":{\"attributes\":[{\"key\":\"service.name\",\"value\":{\"stringValue\":\"tempo-validation\"}}]},\"scopeSpans\":[{\"spans\":[{\"traceId\":\"$trace_id\",\"spanId\":\"1234567890abcdef\",\"name\":\"configuration-smoke\",\"kind\":2,\"startTimeUnixNano\":\"$start_ns\",\"endTimeUnixNano\":\"$end_ns\"}]}]}]}"
docker exec "$tempo_container" /busybox wget -q -T 3 -O /dev/null \
  --header 'Content-Type: application/json' --post-data "$payload" http://127.0.0.1:4318/v1/traces
for attempt in {1..30}; do
  if docker exec "$tempo_container" /busybox wget -q -T 3 -O /dev/null "http://127.0.0.1:3200/api/traces/$trace_id"; then
    printf 'Real OTLP trace accepted through ADOT overlay and queried from Tempo; no AWS network access.\n'
    exit 0
  fi
  sleep 1
done
docker logs "$collector_container" >&2
printf 'Trace was not queryable within 30 seconds.\n' >&2
exit 1
