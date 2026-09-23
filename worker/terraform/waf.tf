# ADR-0004「エッジ防御」1-3（docs/adr/0004-cloudflare-edge-and-scheduling.md:182-186）。
# 既知の経路は worker/src/http/app.ts の openapi 定義から拾う。増減したらここも合わせる。

# 1. DDoS は Free で常時有効・設定不要（ADR-0004）。ここでは触らない。

# 2. WAF Free Managed Ruleset。ADR の指示どおり log で開始し、誤検知を潰してから有効化する。
resource "cloudflare_ruleset" "waf_managed" {
  zone_id     = var.zone_id
  name        = "waf-free-managed-log"
  description = "Cloudflare Free Managed Ruleset。ADR-0004: log で開始し誤検知を潰してから有効化"
  kind        = "zone"
  phase       = "http_request_firewall_managed"

  rules {
    action      = "execute"
    expression  = "true"
    description = "Free Managed Ruleset を log モードで適用"
    enabled     = true

    action_parameters {
      # Cloudflare Managed Ruleset（Free 全プランに含まれる既定セット）の ID。
      # ダッシュボード「セキュリティ → WAF → マネージドルール」で一致することを導入時に確認する。
      id = "efb7b8c949ac4650a09736fc376e9aee"

      overrides {
        action = "log"
      }
    }
  }
}

# 3. WAF カスタムルール（Free は最大 5・正規表現不可。ADR-0004）。
#    「知らない経路・メソッド」を落とす。過大なリクエストは 429/413 を Worker 側で返す方が
#    エンドポイントごとの事情に合わせられるため、ここでは経路・メソッドの 2 本に留める
#    （5 本の枠は残しておき、必要になったときに追加する）。
resource "cloudflare_ruleset" "waf_custom" {
  zone_id     = var.zone_id
  name        = "waf-custom-known-surface"
  description = "既知の経路・メソッド以外を落とす（ADR-0004 エッジ防御 3）"
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  rules {
    action      = "block"
    expression  = "(not (http.request.method in {\"GET\" \"POST\" \"PUT\"}))"
    description = "worker/src/http/app.ts に無いメソッドを落とす（GET/POST/PUT のみ提供）"
    enabled     = true
  }

  rules {
    action      = "block"
    expression  = "(not (starts_with(http.request.uri.path, \"/health\") or starts_with(http.request.uri.path, \"/auth/\") or starts_with(http.request.uri.path, \"/runs\") or starts_with(http.request.uri.path, \"/projects/\") or starts_with(http.request.uri.path, \"/bff/\") or starts_with(http.request.uri.path, \"/doc\")))"
    description = "worker/src/http/app.ts に無い経路を落とす"
    enabled     = true
  }
}
