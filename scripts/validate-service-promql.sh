#!/usr/bin/env bash
set -euo pipefail

# No credentials or runtime network. Docker may pull the pinned public tool image
# if it is not already cached; fixture data comes exclusively from this repository.
cd "$(dirname "$0")/.."
npx --no-install ts-node --prefer-ts-exts scripts/service-promql-fixtures.ts |
  docker run --rm -i --network none --memory 256m --cpus 1 --entrypoint /bin/promtool \
    prom/prometheus@sha256:63805ebb8d2b3920190daf1cb14a60871b16fd38bed42b857a3182bc621f4996 \
    test rules /dev/stdin
