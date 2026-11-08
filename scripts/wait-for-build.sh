#!/usr/bin/env bash
# Usage: wait-for-build.sh <api-base-url> <expected-commit-sha> [timeout-seconds]
# Polls /healthz?deep=1 (also checks the database) until it is healthy AND reports the expected build id. Fails on timeout.
set -euo pipefail
URL="${1:?api base url}"; SHA="${2:?expected sha}"; TIMEOUT="${3:-600}"
deadline=$(( $(date +%s) + TIMEOUT ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  body="$(curl -fsS --max-time 5 "$URL/healthz?deep=1" 2>/dev/null || true)"
  if echo "$body" | grep -q "\"build\":\"$SHA\"" && echo "$body" | grep -q '"status":"ok"'; then
    echo "healthy, serving $SHA: $body"; exit 0
  fi
  echo "waiting... last /healthz: ${body:-<no response>}"; sleep 10
done
echo "timed out waiting for $SHA at $URL" >&2; exit 1
