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
    {"name": "DS_CLOUDWATCH", "pluginId": "cloudwatch", "type": "datasource"},
    {"name": "DS_XRAY", "pluginId": "grafana-x-ray-datasource", "type": "datasource"}
  ]
' "${dashboard_path}" >/dev/null || fail 'dashboard must expose exactly the approved AMP, CloudWatch, and X-Ray import inputs'

jq -e '
  [.panels[] | select(.type == "row") | .title]
  == ["Overview", "Traffic", "Errors", "Latency", "Saturation", "Correlation"]
' "${dashboard_path}" >/dev/null || fail 'dashboard rows differ from the golden-signal and correlation contract'

data_panel_count="$(jq '[.panels[] | select(.type != "row")] | length' "${dashboard_path}")"
[[ "${data_panel_count}" == '17' ]] || fail "expected 17 data panels, found ${data_panel_count}"

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
    "Request Logs by Trace ID",
    "Reservation Created, Claimed, and Completed Rate",
    "Reservation Failures and Diagnostic Exception Rate",
    "Reservation Processor Latency p50/p95/p99",
    "X-Ray Trace by Trace ID"
  ] | sort)
' "${dashboard_path}" >/dev/null || fail 'data-panel titles differ from the 17-panel contract'

jq -e '
  [.panels[] | select(.type != "row")]
  | all(
      (.datasource.type == "prometheus" and .datasource.uid == "${DS_AMP}")
      or (.datasource.type == "cloudwatch" and .datasource.uid == "${DS_CLOUDWATCH}")
      or (.datasource.type == "grafana-x-ray-datasource" and .datasource.uid == "${DS_XRAY}")
    )
' "${dashboard_path}" >/dev/null || fail 'a panel uses a non-imported or unsupported data source'

jq -e '
  [.panels[] | select(.type != "row") | .targets[]]
  | all(
      (.datasource.type == "prometheus" and .datasource.uid == "${DS_AMP}" and (.expr | length) > 0)
      or (.datasource.type == "cloudwatch" and .datasource.uid == "${DS_CLOUDWATCH}")
      or (.datasource.type == "grafana-x-ray-datasource" and .datasource.uid == "${DS_XRAY}")
    )
' "${dashboard_path}" >/dev/null || fail 'a query uses a non-imported data source or an empty PromQL expression'

jq -e '
  [.panels[] | select(.type != "row") | .targets[] | select(.queryMode == "Metrics") | .metricName]
  | sort
  == (["DesiredTaskCount", "HealthyHostCount", "RunningTaskCount", "UnHealthyHostCount"] | sort)
' "${dashboard_path}" >/dev/null || fail 'CloudWatch metric queries differ from the ECS service and ALB health contract'

jq -e '
  .templating.list == [{
    "current": {"selected": false, "text": "", "value": ""},
    "hide": 0,
    "label": "Trace ID",
    "name": "trace_id",
    "query": "",
    "skipUrlSync": false,
    "type": "textbox"
  }]
' "${dashboard_path}" >/dev/null || fail 'dashboard must expose exactly one operator-supplied trace ID variable'

jq -e '
  ([.panels[] | select(.title == "Request Logs by Trace ID")] | length) == 1
  and ([.panels[] | select(.title == "Request Logs by Trace ID")][0] | {
    datasource,
    type,
    targets
  }) == {
    "datasource": {"type": "cloudwatch", "uid": "${DS_CLOUDWATCH}"},
    "type": "logs",
    "targets": [{
      "datasource": {"type": "cloudwatch", "uid": "${DS_CLOUDWATCH}"},
      "expression": "fields @timestamp, @message | filter @message like /${trace_id}/ | sort @timestamp desc | limit 100",
      "logGroupNames": [
        "/movie-platform/aws-demo/reservation-agent/app",
        "/movie-platform/aws-demo/reservation-mcp/app",
        "/movie-platform/aws-demo/recommendation-mcp/app",
        "/movie-platform/aws-demo/reservation-service/app",
        "/movie-platform/aws-demo/recommendation-service/app"
      ],
      "queryMode": "Logs",
      "refId": "A",
      "region": "eu-central-1"
    }]
  }
' "${dashboard_path}" >/dev/null || fail 'trace-correlated CloudWatch Logs panel differs from the approved query contract'

jq -e '
  ([.panels[] | select(.title == "X-Ray Trace by Trace ID")] | length) == 1
  and ([.panels[] | select(.title == "X-Ray Trace by Trace ID")][0] | {
    datasource,
    type,
    targets
  }) == {
    "datasource": {"type": "grafana-x-ray-datasource", "uid": "${DS_XRAY}"},
    "type": "table",
    "targets": [{
      "datasource": {"type": "grafana-x-ray-datasource", "uid": "${DS_XRAY}"},
      "filter": "trace.id = \"${trace_id}\"",
      "queryType": "getTraceSummaries",
      "refId": "A",
      "region": "eu-central-1"
    }]
  }
' "${dashboard_path}" >/dev/null || fail 'X-Ray trace panel differs from the approved exact-trace query contract'

jq -e '
  tostring
  | test("loki|tempo"; "i")
  | not
' "${dashboard_path}" >/dev/null || fail 'dashboard contains an unapproved log or trace data-source reference'

jq -e '
  tostring
  | test("ws-[a-z0-9-]{10,}|placeholder|metric.discovery"; "i")
  | not
' "${dashboard_path}" >/dev/null || fail 'dashboard contains a hardcoded workspace ID or placeholder query'

printf 'Grafana dashboard contract is valid (%s data panels)\n' "${data_panel_count}"
