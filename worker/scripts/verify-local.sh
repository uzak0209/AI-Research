#!/usr/bin/env bash
# wrangler dev が 8787 で動いている前提。本文と鍵は出さない。
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="${LOCAL_BFF_URL:-http://127.0.0.1:8787}"

code=$(curl -sS -o /tmp/ai-research-health.json -w '%{http_code}' --max-time 10 "$BASE/health")
echo "GET /health → $code"
[ "$code" = "200" ]

unauth=$(curl -sS -o /tmp/ai-research-biblio-unauth.json -w '%{http_code}' --max-time 10 \
  -X POST "$BASE/bff/bibliography" -H 'content-type: application/json' \
  -d '{"doi":"10.1038/nature14539"}')
echo "POST /bff/bibliography (no bearer) → $unauth"
[ "$unauth" = "401" ]

go=$(curl -sS -o /tmp/ai-research-google.json -w '%{http_code}' --max-time 10 "$BASE/auth/google")
echo "GET /auth/google → $go"
case "$go" in
  200|501) ;;
  *) echo "unexpected status $go" >&2; exit 1 ;;
esac

token="$(node scripts/mint-access.mjs)"
auth=$(curl -sS -o /tmp/ai-research-biblio.json -w '%{http_code}' --max-time 60 \
  -X POST "$BASE/bff/bibliography" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $token" \
  -d '{"doi":"10.1038/nature14539"}')
echo "POST /bff/bibliography (bearer) → $auth"

# 鍵が無ければ 501。あれば 200（Orca 構造化出力）か上流死の 502。
case "$auth" in
  200|501|502) ;;
  *) echo "unexpected status $auth" >&2; exit 1 ;;
esac

if [ "$auth" = "200" ]; then
  grep -q '"classification":"C1"' /tmp/ai-research-biblio.json
  echo "C1 response ok（title の有無は Orca の構造化出力）"
fi
