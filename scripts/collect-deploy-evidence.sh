#!/usr/bin/env bash
# Captures raw evidence from the DEPLOYED system (DNS, certificate, headers, CORS, health).
# Each file starts with the repo commit, the exact command and a timestamp, then the UNEDITED output.
#   bash scripts/collect-deploy-evidence.sh
# Writes to evidence/deployment/raw/<UTC timestamp>/
set -uo pipefail
cd "$(dirname "$0")/.."

DOMAIN="bklabs10.com"
WEB_PROD="https://fieldday.bklabs10.com"
WEB_STAGING="https://staging.bklabs10.com"
API_PROD="https://fieldday-api-prod.onrender.com"
API_STAGING="https://fieldday-api-staging.onrender.com"

SHA="$(git rev-parse HEAD 2>/dev/null || echo 'NO-GIT-REPO')"
OUT="evidence/deployment/raw/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"

run() { # run <name> <command...>
  local name="$1"; shift
  {
    echo "commit:  $SHA"
    echo "command: $*"
    echo "when:    $(date -u +%FT%TZ)"
    echo "-----"
  } > "$OUT/$name.txt"
  "$@" >> "$OUT/$name.txt" 2>&1
  local rc=$?
  { echo "-----"; echo "exit code: $rc"; } >> "$OUT/$name.txt"
  printf '%-34s exit=%s\n' "$name" "$rc"
}

run 01-dns-caa-default            dig CAA "$DOMAIN" +short
run 02-dns-caa-namecheap-server   dig CAA "$DOMAIN" @dns1.registrar-servers.com +short
run 03-dns-cname-fieldday         dig CNAME "fieldday.$DOMAIN" +short
run 04-dns-cname-staging          dig CNAME "staging.$DOMAIN" +short
run 05-dns-ttl-fieldday           dig "fieldday.$DOMAIN" +noall +answer
run 06-healthz-prod               curl -s "$API_PROD/healthz"
run 07-healthz-staging            curl -s "$API_STAGING/healthz"
run 08-headers-web-html           curl -sI "$WEB_PROD/"
run 09-headers-web-index          curl -sI "$WEB_PROD/index.html"
run 10-headers-api-public         curl -sI "$API_PROD/api/events"
run 11-headers-api-authenticated  curl -sI "$API_PROD/api/me"
run 12-cors-allowed-origin        curl -sI -H "Origin: $WEB_PROD" "$API_PROD/api/events"
run 13-cors-foreign-origin        curl -sI -H "Origin: https://evil.example" "$API_PROD/api/events"
run 14-redirect-http-to-https     curl -sI "http://fieldday.$DOMAIN/"
run 15-tls-certificate            bash -c "echo | openssl s_client -connect fieldday.$DOMAIN:443 -servername fieldday.$DOMAIN 2>/dev/null | openssl x509 -noout -issuer -subject -dates -fingerprint -sha256"

echo
echo "Evidence written to $OUT  (commit: $SHA)"
echo "The Render deploy and Namecheap/GitHub screens still need screenshots."
