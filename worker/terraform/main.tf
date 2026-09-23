# ADR-0004 のエッジ防御（WAF・レート制限）をコードで持つ。
# 手動のダッシュボード設定を正にしない（ADR-0004 の決定・#106 の指摘の是正）。
#
# 対象は prod ゾーンのみ。dev / test は workers.dev のままでゾーン防御の対象外（ADR-0004）。
# routes[0] のリソース作成自体（Worker へのルーティング）は wrangler が持つ。ここはゾーンの
# WAF / レート制限だけを持つ（wrangler にゾーン設定の手段が無いため）。
#
# 使い方（人が一度だけ実行。CI からは呼ばない。prod のゾーン防御を毎 push で触らない）:
#   cd worker/terraform
#   terraform init
#   terraform apply \
#     -var="cloudflare_api_token=$CLOUDFLARE_API_TOKEN" \
#     -var="zone_id=<ai-research.streeeak.link の Zone ID>"
#
# CLOUDFLARE_API_TOKEN には Zone: WAF: Edit と Zone: Rate Limiting: Edit を追加すること
# （worker/README.md の権限表を参照。prod 用トークンにのみ付ける）。
#
# 注意: WAF Managed Ruleset の ID・レート制限の閾値は ADR-0004 の記述をそのまま起こした
# 初期値。実機のダッシュボードで ID が変わっていないか、閾値が誤検知を起こさないかは
# 導入時に確認すること（ADR-0004 未決事項と同じ理由で、ここではネットワーク越しに検証できない）。

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
