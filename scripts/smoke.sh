#!/usr/bin/env bash
# Usage: smoke.sh <api-base-url> <web-base-url>
# Post-deploy checks that need no credentials: health, public read, auth enforced, caching split, HTTPS redirect.
set -euo pipefail
API="${1:?api url}"; WEB="${2:?web url}"
fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@"; }

[ "$(code "$API/healthz?deep=1")" = 200 ] || fail "healthz"
[ "$(code "$API/api/events")" = 200 ] || fail "public list"
[ "$(code -X POST -H 'Content-Type: application/json' -d '{}' "$API/api/events")" = 401 ] || fail "write without token must be 401"
[ "$(code "$API/api/me")" = 401 ] || fail "/api/me without token must be 401"
[ "$(code -X POST "$API/mcp")" = 401 ] || fail "mcp without token must be 401"
curl -sI "$API/api/events" | grep -qi '^cache-control: public' || fail "public API response should be publicly cacheable"
curl -sI "$API/api/me" | grep -qi '^cache-control: private, no-store' || fail "authenticated response must be private, no-store"
[ "$(code "$WEB/")" = 200 ] || fail "web index"
http_url="http://${WEB#https://}"
loc="$(curl -s -o /dev/null -w '%{redirect_url}' --max-time 10 "$http_url/")"
case "$loc" in https://*) ;; *) fail "http should redirect to https (got '$loc')";; esac
echo "smoke ok"
