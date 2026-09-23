variable "cloudflare_api_token" {
  description = "Zone: WAF: Edit / Zone: Rate Limiting: Edit を持つ API トークン（値はコミットしない。C-06）"
  type        = string
  sensitive   = true
}

variable "zone_id" {
  description = "ai-research.streeeak.link の Zone ID（Cloudflare ダッシュボード → ドメイン概要 右下）"
  type        = string
}
