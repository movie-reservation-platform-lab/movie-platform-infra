#!/usr/bin/env bash

set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
dashboard_path="${script_directory}/../grafana/dashboards/movie-reservation-aws-overview.json"

fail() {
  printf 'Grafana dashboard validation failed: %s\n' "$1" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || fail 'jq is required'
jq empty "${dashboard_path}" >/dev/null || fail 'dashboard is not valid JSON'

jq -e '
  .uid == "movie-reservation-aws-overview"
  and .time == {"from": "now-1h", "to": "now"}
  and .refresh == "30s"
' "${dashboard_path}" >/dev/null || fail 'UID, default time range, or refresh interval differs from the contract'

jq -e '
  ([.__inputs[] | {name, pluginId, type}] | sort_by(.name))
  == [
    {"name": "DS_AMP", "pluginId": "prometheus", "type": "datasource"},
    {"name": "DS_CLOUDWATCH", "pluginId": "cloudwatch", "type": "datasource"}
  ]
' "${dashboard_path}" >/dev/null || fail 'dashboard must expose exactly the AMP and CloudWatch import inputs'

jq -e '
  [.panels[] | select(.type == "row") | .title]
  == ["Overview", "Traffic", "Errors", "Latency", "Saturation"]
' "${dashboard_path}" >/dev/null || fail 'golden-signal rows differ from the five-row contract'

data_panel_count="$(jq '[.panels[] | select(.type != "row")] | length' "${dashboard_path}")"
[[ "${data_panel_count}" == '15' ]] || fail "expected 15 data panels, found ${data_panel_count}"

jq -e '
  ([.panels[] | select(.type != "row") | .title] | sort)
  == ([
    "ECS CPU Reserved vs Utilized",
    "ECS Memory Reserved vs Utilized",
    "ECS Service and ALB Target Health",
    "GraphQL Error Rate",
    "GraphQL Error Ratio",
    "GraphQL Latency p50/p95/p99",
    "GraphQL P95 Latency",
    "GraphQL Rate by Operation and Outcome",
    "GraphQL Request Rate",
    "HTTP 5xx Rate",
    "HTTP Latency p50/p95/p99",
    "HTTP Rate by Route and Status",
    "Reservation Created, Claimed, and Completed Rate",
    "Reservation Failures and Diagnostic Exception Rate",
    "Reservation Processor Latency p50/p95/p99"
  ] | sort)
' "${dashboard_path}" >/dev/null || fail 'data-panel titles differ from the 15-panel contract'

jq -e '
  [.panels[] | select(.type != "row")]
  | all(
      (.datasource.type == "prometheus" and .datasource.uid == "${DS_AMP}")
      or (.datasource.type == "cloudwatch" and .datasource.uid == "${DS_CLOUDWATCH}")
    )
' "${dashboard_path}" >/dev/null || fail 'a panel uses a non-imported or unsupported data source'

jq -e '
  [.panels[] | select(.type != "row") | .targets[]]
  | all(
      (.datasource.type == "prometheus" and .datasource.uid == "${DS_AMP}" and (.expr | length) > 0)
      or (.datasource.type == "cloudwatch" and .datasource.uid == "${DS_CLOUDWATCH}")
    )
' "${dashboard_path}" >/dev/null || fail 'a query uses a non-imported data source or an empty PromQL expression'

jq -e '
  [.panels[] | select(.type != "row") | .targets[] | select(.datasource.type == "cloudwatch") | .metricName]
  | sort
  == (["DesiredTaskCount", "HealthyHostCount", "RunningTaskCount", "UnHealthyHostCount"] | sort)
' "${dashboard_path}" >/dev/null || fail 'CloudWatch queries differ from the ECS service and ALB health contract'

jq -e '
  tostring
  | test("loki|tempo|x-?ray"; "i")
  | not
' "${dashboard_path}" >/dev/null || fail 'dashboard contains a deferred log or trace data-source reference'

jq -e '
  tostring
  | test("ws-[a-z0-9-]{10,}|placeholder|metric.discovery"; "i")
  | not
' "${dashboard_path}" >/dev/null || fail 'dashboard contains a hardcoded workspace ID or placeholder query'

printf 'Grafana dashboard contract is valid (%s data panels)\n' "${data_panel_count}"
