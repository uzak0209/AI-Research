#!/usr/bin/env bash
# staging（D1 dev）またはローカル D1 に機能紹介用 seed を入れる。
#
#   ./scripts/seed.sh remote    # Cloudflare 上の ai-research-dev
#   ./scripts/seed.sh local     # wrangler の local D1
#
# seed-demo ユーザー／プロジェクトだけを入れ直す。本番 D1 には当てない。
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-}"
if [[ "$MODE" != "local" && "$MODE" != "remote" ]]; then
  echo "usage: $0 <local|remote>" >&2
  exit 1
fi

if [[ "$MODE" == "remote" ]]; then
  echo "remote は env.dev の D1（ai-research-dev）。prod には当てない。" >&2
fi

SQL_FILE="$(mktemp)"
trap 'rm -f "$SQL_FILE"' EXIT
node ../seed/apply.mjs --cloud-sql > "$SQL_FILE"

ARGS=(d1 execute ai-research-dev --env dev --file "$SQL_FILE" --yes)
if [[ "$MODE" == "remote" ]]; then
  ARGS+=(--remote)
else
  ARGS+=(--local)
fi

npx wrangler "${ARGS[@]}"
echo "seed-demo を ${MODE} D1 に入れた。cron の収集対象になる（公開 summary のみ）。"
