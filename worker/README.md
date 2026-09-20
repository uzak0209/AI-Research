# worker

[ADR-0004](../docs/adr/0004-cloudflare-edge-and-scheduling.md) のクラウド側。
HTTP と cron を 1 つの Worker に同居させる。

> **設計フェーズのデプロイ土台。** 未決の部分は実装したふりをせず 501 を返す（`C-07`）。

| 経路 | 状態 |
|---|---|
| `GET /health` | 動く。CI の疎通確認に使う |
| `GET /runs`（同期 API・FR-02） | **501**。認証の上流 IdP と署名鍵の入れ替えが未決 |
| `POST /bff/*`（FR-10） | **501**。分類（C1/C2/C3）決定後に足す |
| cron → Queues 投入 | 動く |
| Queue コンシューマ → D1 | 動く（ソースは OpenAlex 1 つ） |

## 構成

| 要素 | 使うもの | 理由（ADR-0004） |
|---|---|---|
| 実行 | Workers（HTTP と cron を同居） | ランタイムを増やさない。分けると設定と型が二重になる |
| 保存 | D1（`dev` / `prod` で分ける） | 公開データのみで量が小さい |
| 分散 | Queues（1 メッセージ = 1 プロジェクト × ソース） | CPU 10ms/実行 の回避 |
| 冪等 | KV | cron・Queues とも at-least-once |
| 秘密 | Workers Secrets | 鍵をクライアントに置かない（`C-06`） |

## 初回セットアップ（人が一度だけ）

```bash
cd worker
npm ci
npx wrangler login
./scripts/bootstrap.sh dev     # D1 / Queue / DLQ / KV を作る
```

出力された ID を `wrangler.jsonc` の `PLACEHOLDER_*` に貼る。
**ID は秘密ではないのでコミットしてよい。** 秘密は Workers Secrets だけに置く。

`prod` は加えて `env.prod.routes[0].pattern` を実際の独自ドメインにする。
`workers.dev` のままだとゾーンの WAF とレート制限が効かない（ADR-0004）。

### GitHub 側

Settings → Secrets and variables → Actions。**Secret と Variable はタブが違う。**

| 種別 | 名前 | 中身 |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | 下の権限を持つ API トークン |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | アカウント ID（`npx wrangler whoami` で出る） |
| Variable | `DEV_HEALTH_URL` | 例: `https://ai-research-api-dev.<sub>.workers.dev/health` |
| Variable | `PROD_HEALTH_URL` | 例: `https://api.example.com/health` |

`*_HEALTH_URL` は秘密ではないので Variable。未設定なら疎通確認は警告を出して飛ばす
（deploy 自体は成功扱い）。

#### API トークンの権限

**既定テンプレート「Edit Cloudflare Workers」だけでは足りない。**
CI が `d1 migrations apply` と Queues のバインディング解決を行うため。

| 種別 | 権限 | 要る理由 |
|---|---|---|
| Account | Workers Scripts : Edit | `wrangler deploy` |
| Account | D1 : Edit | `d1 migrations apply --remote` |
| Account | Queues : Edit | Queue バインディングの解決 |
| Account | Workers KV Storage : Edit | KV バインディングの解決 |
| Account | Account Settings : Read | アカウントの解決 |
| Zone | Workers Routes : Edit | **prod のみ。**独自ドメイン（`custom_domain`） |

#### 環境ごとに分ける（推奨）

ワークフローは `environment: dev` / `environment: prod` を使うので、
**Environment 単位で別の Secret を持てる**。dev 用トークンに prod を触らせない構成にできる。

Settings → Environments → `dev` / `prod` を作り、それぞれに `CLOUDFLARE_API_TOKEN` を置く。
リポジトリ全体の Secret より優先される。

`prod` は Environment で承認を必須にできる。誤 deploy を止める最後の砦。

### Workers Secrets は今のところ不要

`wrangler secret put` で入れる秘密は、**現在のコードが 1 つも参照していない**。
`JWT_SIGNING_KEY` / `ORCAROUTER_API_KEY` は `/runs` と `/bff/*` が 501 の間は使われない。
認証と BFF を実装する時点で入れる。

Worker が実際に読むのは `DB` / `IDEMPOTENCY` / `COLLECT_QUEUE`（バインディング）と
`ENVIRONMENT` / `CONSENT_VERSION`（`wrangler.jsonc` の `vars`）だけ。

## CI/CD

[.github/workflows/deploy-worker.yml](../.github/workflows/deploy-worker.yml)。
ブランチ規約（`AGENTS.md`: feature → `dev` → `main`）に合わせてある。

| 契機 | やること |
|---|---|
| PR → `dev` / `main` | `validate` のみ。deploy しない |
| push → `dev` | migrations → deploy（`--env dev`）→ 疎通確認 |
| push → `main` | migrations → deploy（`--env prod`）→ 疎通確認 |
| 手動実行 | 環境を選んで deploy |

`validate` の中身:

1. `PLACEHOLDER_` が残っていたら落とす（存在しないリソースへ deploy させない）
2. `wrangler types` → `tsc --noEmit`
3. `wrangler deploy --dry-run` を dev / prod の両方

**マイグレーションを deploy より先に当てる。** 逆にすると、新しい列を読むコードが
列の無い DB に当たる時間が生まれる。

**インフラの作成は CI でやらない。** 毎回の push で作ると事故が戻せない。

### 戻し方

自動ロールバックはしない。失敗時はログに手順が出る。

```bash
cd worker && npx wrangler rollback --env prod
```

## ローカル

```bash
npm run dev                          # wrangler dev
npx wrangler dev --test-scheduled    # cron を叩く: /__scheduled
npx wrangler d1 migrations apply ai-research-dev --local
```

## Free 枠で効く制約（ADR-0004）

コードを変えるときはこれを壊していないか見る。

- **CPU 10ms / 1 実行。** 粗い採点は文字列一致の水準に留める（`coarseScore`）
- **サブリクエスト 50 / 1 実行。** ページングは次のメッセージへ回す
- **D1 は 1 実行 50 クエリ。** `run_papers` は 20 行ずつ 1 文にまとめている
- **cron はアカウントで 5 本。** 使うのは収集投入の 1 本だけ
- **UTC のみ。** 夏時間の影響を受けない時刻を選ぶ

## 未対応

- **WAF・レート制限がコード管理になっていない。** ADR-0004 は「wrangler / Terraform で
  コード管理」としているが、これらはゾーンの設定で wrangler では扱えない。Terraform が要る
- 認証（OAuth + PKCE、JWT 検証、署名鍵の入れ替え）
- BFF endpoint と OrcaRouter 連携
- `runs` / `run_papers` の保持期間の削除処理
