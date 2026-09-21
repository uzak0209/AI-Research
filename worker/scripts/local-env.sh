#!/usr/bin/env bash
# ローカル wrangler 用の .dev.vars / .env と D1 を用意する。値は標準出力に出さない（C-06）。
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
  for key in GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET; do
    if ! grep -q "^${key}=" "$TARGET"; then
      echo "${key}=" >> "$TARGET"
    fi
  done
fi

has_value() {
  local name="$1" file="$2"
  awk -F= -v k="$name" '$1 == k && $2 != "" { found=1 } END { exit found ? 0 : 1 }' "$file"
}

echo "JWT_SIGNING_KEY: $(has_value JWT_SIGNING_KEY "$TARGET" && echo set || echo missing)"
echo "ORCAROUTER_API_KEY: $(has_value ORCAROUTER_API_KEY "$TARGET" && echo set || echo empty→C1 trends は 501)"
echo "OPENALEX_API_KEY: $(has_value OPENALEX_API_KEY "$TARGET" && echo set || echo empty→OpenAlex は共有 IP で落ちうる)"
echo "JEV_API_KEY: $(has_value JEV_API_KEY "$TARGET" && echo set || echo empty→bibliography は 501)"
echo "GOOGLE_OAUTH_CLIENT_ID: $(has_value GOOGLE_OAUTH_CLIENT_ID "$TARGET" && echo set || echo empty→Google ログインは 501)"

# wrangler --env X は .env ではなく .env.X を読む。同じ CLI トークンを 3 つへ張る。
if [ ! -f .env.example ]; then
  echo "missing .env.example" >&2
  exit 1
fi
if [ ! -f .env ]; then
  cp .env.example .env
  echo "created .env from example（CLOUDFLARE_API_TOKEN は空。ダッシュボードで発行して貼る）"
else
  echo ".env は既にある。上書きしない"
fi
for env_name in dev test prod; do
  ln -sfn .env ".env.${env_name}"
done
echo "linked .env.dev / .env.test / .env.prod -> .env"
echo "CLOUDFLARE_ACCOUNT_ID: $(has_value CLOUDFLARE_ACCOUNT_ID .env && echo set || echo empty)"
echo "CLOUDFLARE_API_TOKEN: $(has_value CLOUDFLARE_API_TOKEN .env && echo set || echo empty→remote 操作は OAuth アカウントに向かう)"

npx wrangler d1 migrations apply ai-research-dev --local --env dev
echo "local D1 migrations applied"
