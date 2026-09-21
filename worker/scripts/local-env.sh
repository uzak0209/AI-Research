#!/usr/bin/env bash
# ローカル wrangler 用の .dev.vars と D1 を用意する。値は標準出力に出さない（C-06）。
#
#   ./scripts/local-env.sh
set -euo pipefail
cd "$(dirname "$0")/.."

EXAMPLE=".dev.vars.example"
TARGET=".dev.vars"

if [ ! -f "$EXAMPLE" ]; then
  echo "missing $EXAMPLE" >&2
  exit 1
fi

if [ ! -f "$TARGET" ]; then
  cp "$EXAMPLE" "$TARGET"
  echo "created $TARGET from example（JWT はローカル用。有料キーは空）"
else
  echo "$TARGET は既にある。上書きしない"
fi

has_value() {
  local name="$1"
  awk -F= -v k="$name" '$1 == k && $2 != "" { found=1 } END { exit found ? 0 : 1 }' "$TARGET"
}

echo "JWT_SIGNING_KEY: $(has_value JWT_SIGNING_KEY && echo set || echo missing)"
echo "ORCAROUTER_API_KEY: $(has_value ORCAROUTER_API_KEY && echo set || echo empty→C1 trends は 501)"
echo "OPENALEX_API_KEY: $(has_value OPENALEX_API_KEY && echo set || echo empty→OpenAlex は共有 IP で落ちうる)"
echo "JEV_API_KEY: $(has_value JEV_API_KEY && echo set || echo empty→bibliography は 501)"

npx wrangler d1 migrations apply ai-research-dev --local --env dev
echo "local D1 migrations applied"
