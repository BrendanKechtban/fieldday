#!/usr/bin/env bash
# Collects raw, reproducible evidence for everything that can be produced locally. Every file starts with the commit SHA,
# the exact command, a timestamp and the machine's Node version, then the UNEDITED output. Interpretation goes in docs, not here.
#   bash scripts/collect-evidence.sh            -> evidence/raw/<UTC timestamp>/
set -uo pipefail
cd "$(dirname "$0")/.."
SHA="${BUILD_SHA:-$(git rev-parse HEAD 2>/dev/null || echo 'NO-GIT-REPO (run git init && git commit first)')}"
OUT="evidence/raw/$(date -u +%Y%m%dT%H%M%SZ)"; mkdir -p "$OUT"
run() { # run <name> <command...>
  local name="$1"; shift
  { echo "commit:  $SHA"; echo "command: $*"; echo "when:    $(date -u +%FT%TZ)"; echo "node:    $(node -v)"; echo "-----"; } > "$OUT/$name.txt"
  "$@" >> "$OUT/$name.txt" 2>&1; local rc=$?
  echo "-----" >> "$OUT/$name.txt"; echo "exit code: $rc" >> "$OUT/$name.txt"
  printf '%-28s exit=%s\n' "$name" "$rc"
}
run 01-tests-all           npm test
run 02-build               npm run build
run 03-gameday-capacity    node scripts/gameday.mjs capacity
run 04-gameday-weather     node scripts/gameday.mjs weather-timeout
run 05-gameday-sse         node scripts/gameday.mjs sse-recovery
run 06-rate-limiting       node scripts/gameday.mjs rate-limit
run 07-audit-prod-deps     npm audit --omit=dev
run 08-cost-model          node scripts/cost-model.mjs
echo; echo "Evidence written to $OUT  (commit: $SHA)"
echo "Still needed from a REAL deployment (cannot be produced here): see docs/REQUIREMENTS.md, 'Needs you'."
