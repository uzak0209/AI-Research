#!/usr/bin/env bash
# Cloudflare 側のリソースを一度だけ作る。**CI からは呼ばない。**
#
#   ./scripts/bootstrap.sh dev
#   ./scripts/bootstrap.sh prod
#
# CI で毎回インフラを作らないのは、事故ったときに戻せないため。
# ここで出た ID を wrangler.jsonc の PLACEHOLDER_* に貼る。
# ID は秘密ではないのでコミットしてよい（秘密は Workers Secrets のみ。C-06）。

set -euo pipefail

ENV_NAME="${1:-}"
if [ "$ENV_NAME" != "dev" ] && [ "$ENV_NAME" != "prod" ]; then
  echo "usage: $0 <dev|prod>" >&2
  exit 1
fi

if [ "$ENV_NAME" = "dev" ]; then
  D1_NAME="ai-research-dev"
  KV_NAME="IDEMPOTENCY_DEV"
  QUEUE="ai-research-collect-dev"
else
  D1_NAME="ai-research-prod"
  KV_NAME="IDEMPOTENCY_PROD"
  QUEUE="ai-research-collect"
fi
DLQ="${QUEUE}-dlq"

echo "=== ${ENV_NAME} のリソースを作る ==="
echo "先に 'npx wrangler login' を済ませておくこと。"
echo

# 既にあれば作らない。bootstrap を二度走らせても壊れないようにする。
#
# 名前の判定は**完全一致**で行う。部分一致にすると
# "ai-research-collect-dev" があるせいで "ai-research-collect" を
# 作成済みと誤判定する（実際にそれで prod のキューが作られなかった）。
create_if_absent() {
  local kind="$1" name="$2" cmd="$3" list_cmd="$4"
  # 出力は表（queues）と JSON（d1 / kv）が混ざる。
  # 罫線・引用符・カンマを落としてから、語として完全一致するか見る
  if eval "$list_cmd" 2>/dev/null       | tr -s ' │|	",' '





'       | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'       | grep -qx -- "$name"; then
    echo "[skip] ${kind} ${name} は既にある"
  else
    echo "[create] ${kind} ${name}"
    eval "$cmd"
  fi
}

create_if_absent "D1"    "$D1_NAME" "npx wrangler d1 create '$D1_NAME'"        "npx wrangler d1 list 2>/dev/null"
create_if_absent "Queue" "$QUEUE"   "npx wrangler queues create '$QUEUE'"      "npx wrangler queues list 2>/dev/null"
create_if_absent "Queue" "$DLQ"     "npx wrangler queues create '$DLQ'"        "npx wrangler queues list 2>/dev/null"
create_if_absent "KV"    "$KV_NAME" "npx wrangler kv namespace create '$KV_NAME'" "npx wrangler kv namespace list 2>/dev/null"

cat <<EOS

=== 次にやること ===

1. 上の出力から ID を拾い、worker/wrangler.jsonc の該当箇所を置き換える
     env.${ENV_NAME}.d1_databases[0].database_id  <- D1 の ID
     env.${ENV_NAME}.kv_namespaces[0].id          <- KV の ID
$( [ "$ENV_NAME" = "prod" ] && echo "     env.prod.routes[0].pattern                   <- 公開する独自ドメイン" )

2. 秘密を入れる（値は対話で聞かれる。引数やログに出さない。C-06）
     npx wrangler secret put JWT_SIGNING_KEY --env ${ENV_NAME}
     npx wrangler secret put ORCAROUTER_API_KEY --env ${ENV_NAME}
     npx wrangler secret put JEV_API_KEY --env ${ENV_NAME}

3. マイグレーションを当てる
     npx wrangler d1 migrations apply ${D1_NAME} --remote

4. GitHub の Secrets に登録（CI 用）
     CLOUDFLARE_API_TOKEN   … Workers/D1/KV/Queues の編集権限を持つトークン
     CLOUDFLARE_ACCOUNT_ID  … アカウント ID

注意: WAF・レート制限はゾーンの設定で、wrangler では管理できない。
      ADR-0004 は「コードで管理」としているので、別途 Terraform が要る（未対応）。
EOS
