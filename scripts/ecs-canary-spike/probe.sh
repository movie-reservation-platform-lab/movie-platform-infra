#!/usr/bin/env bash
# Steady HTTP probe for the ECS canary spike (infra#100).
#
# Records one CSV row per request (epoch_ms,http_status,variant) so the
# client-side traffic split can be compared with the listener-rule weights.
# Read-only toward AWS: it only sends HTTP requests to the spike ALB.
#
# Usage:
#   probe.sh run --url http://<alb-dns>/ --out <file.csv> [--rate 5] [--duration 0]
#   probe.sh summarize <file.csv> [--bucket 10]
#   probe.sh --self-test
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE_DIR="$SCRIPT_DIR/../../test/fixtures/ecs-canary-spike"

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'
  exit 2
}

probe_once() {
  local url="$1" out="$2" started headers status variant
  started="$(date +%s%3N)"
  headers="$(curl --silent --max-time 2 --output /dev/null --dump-header - "$url" 2>/dev/null || true)"
  status="$(printf '%s' "$headers" | awk 'toupper($1) ~ /^HTTP\// { code = $2 } END { print (code == "" ? "000" : code) }')"
  variant="$(printf '%s' "$headers" | tr -d '\r' | awk -F': ' 'tolower($1) == "x-spike-variant" { v = $2 } END { print (v == "" ? "none" : v) }')"
  printf '%s,%s,%s\n' "$started" "$status" "$variant" >>"$out"
}

run_probe() {
  local url='' out='' rate=5 duration=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --url) url="$2"; shift 2 ;;
      --out) out="$2"; shift 2 ;;
      --rate) rate="$2"; shift 2 ;;
      --duration) duration="$2"; shift 2 ;;
      *) usage ;;
    esac
  done
  [[ -n "$url" && -n "$out" ]] || usage
  # An empty $(stack_output ...) turns the URL into "http:///"; refuse it.
  [[ "$url" =~ ^https?://[^/]+ ]] || { printf 'probe: --url needs a host, got %s\n' "$url" >&2; exit 2; }
  [[ "$rate" =~ ^[1-9][0-9]*$ && "$duration" =~ ^[0-9]+$ ]] || usage

  local interval end
  interval="$(awk -v r="$rate" 'BEGIN { printf "%.3f", 1 / r }')"
  end=$(( duration == 0 ? 0 : $(date +%s) + duration ))
  [[ -s "$out" ]] || printf 'epoch_ms,http_status,variant\n' >"$out"
  printf 'probing %s at %s req/s into %s (Ctrl-C to stop)\n' "$url" "$rate" "$out" >&2
  while [[ "$end" -eq 0 || "$(date +%s)" -lt "$end" ]]; do
    # Requests run in the background so slow responses do not lower the rate.
    probe_once "$url" "$out" &
    sleep "$interval"
  done
  wait
}

# Per-bucket request counts per variant and failure counts, relative to the
# first request, followed by the first and last time each variant was seen.
# Failures are split by where they come from:
#   target_5xx   5xx with an x-spike-variant header: the app answered with an
#                error (the ALB's HTTPCode_Target_5XX_Count, which the alarm uses);
#   elb_5xx      5xx without the header: the ALB generated it, e.g. 502 on a
#                dropped keep-alive connection (HTTPCode_ELB_5XX_Count);
#   no_response  000: no HTTP response at all, usually the client's network.
summarize() {
  local file="$1" bucket="${2:-10}" variants
  [[ -f "$file" ]] || { printf 'no such file: %s\n' "$file" >&2; exit 2; }
  # POSIX awk only (no gawk extensions): variant order comes from sort.
  variants="$(tail -n +2 "$file" | cut -d, -f3 | LC_ALL=C sort -u | paste -sd, -)"
  printf 't_start_s,total,target_5xx,elb_5xx,no_response,%s\n' "$variants"
  tail -n +2 "$file" | awk -F, -v bucket="$bucket" -v variants="$variants" '
    BEGIN { n = split(variants, names, ",") }
    {
      if (start == "") start = $1
      b = int(($1 - start) / 1000 / bucket) * bucket
      seen[b] = 1; total[b]++; count[b, $3]++
      if ($2 == "000") no_response[b]++
      else if ($2 >= 500 && $3 == "none") elb_5xx[b]++
      else if ($2 >= 500) target_5xx[b]++
    }
    END {
      for (b in seen) {
        line = b "," total[b] "," (target_5xx[b] + 0) "," (elb_5xx[b] + 0) "," (no_response[b] + 0)
        for (i = 1; i <= n; i++) line = line "," (count[b, names[i]] + 0)
        print line
      }
    }
  ' | sort -t, -k1,1n
  printf '\nvariant,first_seen_s,last_seen_s\n'
  tail -n +2 "$file" | awk -F, '
    {
      if (start == "") start = $1
      t = ($1 - start) / 1000
      if (!($3 in first)) first[$3] = t
      last[$3] = t
    }
    END { for (v in first) printf "%s,%.1f,%.1f\n", v, first[v], last[v] }
  ' | LC_ALL=C sort
}

self_test() {
  local actual expected
  actual="$(summarize "$FIXTURE_DIR/probe-sample.csv" 10)"
  expected="$(cat "$FIXTURE_DIR/probe-sample.summary.txt")"
  if [[ "$actual" != "$expected" ]]; then
    printf 'probe self-test failed\n--- expected\n%s\n--- actual\n%s\n' "$expected" "$actual" >&2
    exit 1
  fi
  printf 'ECS canary probe self-test passed\n'
}

case "${1:-}" in
  run) shift; run_probe "$@" ;;
  summarize) shift; summarize "$1" "${3:-10}" ;;
  --self-test) self_test ;;
  *) usage ;;
esac
