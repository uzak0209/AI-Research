# ADR-0004「エッジ防御」4（docs/adr/0004-cloudflare-edge-and-scheduling.md:187）。
# 認証前の入口（/auth/google。worker/src/http/app.ts）に限る。
# NAT 配下を巻き込むため緩い閾値から始める（ADR-0004）。閾値は初期値であり、
# 誤検知が出れば requests_per_period を上げて調整する。
resource "cloudflare_ruleset" "rate_limit_auth" {
  zone_id     = var.zone_id
  name        = "rate-limit-pre-auth"
  description = "認証前の入口（/auth/google）の IP 基準レート制限（ADR-0004 エッジ防御 4）"
  kind        = "zone"
  phase       = "http_ratelimit"

  rules {
    action      = "block"
    expression  = "(http.request.uri.path eq \"/auth/google\")"
    description = "10 秒窓・IP 基準。NAT 配下を巻き込むため緩い閾値から（ADR-0004）"
    enabled     = true

    ratelimit {
      characteristics     = ["ip.src"]
      period              = 10
      requests_per_period = 20
      mitigation_timeout  = 60
    }
  }
}
