#!/usr/bin/env bash
# Cloudflare 側のリソースを冪等に作る。
#
#   ./scripts/bootstrap.sh test
#   ./scripts/bootstrap.sh dev
#   ./scripts/bootstrap.sh prod
#
# dev / prod は人が一度だけ走らせる。CI の毎回の push から呼ぶと事故が戻せない。
# test だけは例外で、deploy-test が初回に呼んでよい（隔離環境。壊しても作り直せる）。
#
# ここで出た ID を wrangler.jsonc に貼る。ID は秘密ではない（秘密は Workers Secrets のみ。C-06）。
# test も dev / prod と同じく ID をコミットしてよい。deploy-test は冪等に作り直せる。

set -euo pipefail

ENV_NAME="${1:-}"
case "$ENV_NAME" in
  test)
    D1_NAME="ai-research-test"
    KV_NAME="IDEMPOTENCY_TEST"
    QUEUE="ai-research-collect-test"
    ;;
  dev)
    D1_NAME="ai-research-dev"
    KV_NAME="IDEMPOTENCY_DEV"
    QUEUE="ai-research-collect-dev"
    ;;
  prod)
    D1_NAME="ai-research-prod"
    KV_NAME="IDEMPOTENCY_PROD"
    QUEUE="ai-research-collect"
    ;;
  *)
    echo "usage: $0 <test|dev|prod>" >&2
    exit 1
    ;;
esac
DLQ="${QUEUE}-dlq"

echo "=== ${ENV_NAME} のリソースを作る ==="
echo "先に 'npx wrangler login' を済ませておくか、CLOUDFLARE_API_TOKEN を置くこと。"
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
  if eval "$list_cmd" 2>/dev/null \
       | tr -s ' │|	",' ' ' \
       | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' \
       | grep -qx -- "$name"; then
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

if [ "$ENV_NAME" = "test" ]; then
  cat <<EOS

=== test の次 ===

deploy-test（GitHub Actions）が wrangler.jsonc の PLACEHOLDER_TEST_* を
ランナー上で実 ID に差し替え、migration と seed を当てて deploy する。
ID をコミットする必要はない。cron は付けない。

手動で続ける場合:
     npx wrangler d1 migrations apply ${D1_NAME} --remote --env test
     npx wrangler d1 execute ${D1_NAME} --remote --file=scripts/seed-test.sql
     npx wrangler deploy --env test
EOS
  exit 0
fi

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
     npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID --env ${ENV_NAME}
     npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET --env ${ENV_NAME}

3. マイグレーションを当てる
     npx wrangler d1 migrations apply ${D1_NAME} --remote

4. GitHub の Secrets に登録（CI 用）
     CLOUDFLARE_API_TOKEN   … Workers/D1/KV/Queues の編集権限を持つトークン
     CLOUDFLARE_ACCOUNT_ID  … アカウント ID

$( [ "$ENV_NAME" = "prod" ] && cat <<'EOS2'
5. WAF・レート制限を適用する（ゾーンの設定で、wrangler では管理できない。ADR-0004）
     cd terraform
     terraform init
     terraform apply -var="cloudflare_api_token=$CLOUDFLARE_API_TOKEN" -var="zone_id=<ai-research.streeeak.link の Zone ID>"
   トークンに Zone: WAF: Edit / Zone: Rate Limiting: Edit が要る（worker/README.md）。
   dev / test は workers.dev のままでゾーン防御の対象外なので実行しない（ADR-0004）。
EOS2
)
EOS
