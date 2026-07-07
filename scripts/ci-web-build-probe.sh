#!/usr/bin/env bash
# CI: build the web app the way the update/install flows do — into a production
# dist dir via GINI_DIST_DIR — and prove the result actually serves. Installed
# runtimes serve `next start` from such a bundle (ADR web-production-serving.md),
# so a commit that fails to build or boot in prod mode must never land on
# main: it's exactly what every install pulls on its next update.
#
# Extracted from .github/workflows/ci.yml so the CI "build-web" matrix leg is a
# single command. Run from the repo root.
set -euo pipefail

cd packages/web

GINI_DIST_DIR=.next-prod-ci bun run build

GINI_INSTANCE=ci GINI_DIST_DIR=.next-prod-ci PORT=7997 \
  bun run start -- -H 127.0.0.1 -p 7997 &
server=$!
# Kill the server on every exit path — a leaked next-start would hold the job
# open until the timeout cap.
trap 'kill "$server" 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  body="$(curl -fsS http://127.0.0.1:7997/api/runtime/__healthz 2>/dev/null || true)"
  if printf '%s' "$body" | grep -q '"service":"gini-web"'; then
    echo "healthz answered: $body"
    exit 0
  fi
  sleep 1
done

echo "web production server never answered /api/runtime/__healthz" >&2
exit 1
