# worker

[ADR-0004](../docs/adr/0004-cloudflare-edge-and-scheduling.md) のクラウド側。
HTTP と cron を 1 つの Worker に同居させる。

> **設計フェーズのデプロイ土台。** 未決の部分は実装したふりをせず 501 を返す（`C-07`）。

| 経路 | 状態 |
|---|---|
| `GET /health` | 動く。CI の疎通確認に使う |
| `GET /doc` | OpenAPI |
| `GET /auth/google` | Google OAuth の `client_id`。secret は出さない。未設定なら **501** |
| `POST /auth/google` | code + PKCE → 自前 JWT。Google の access は返さない |
| `POST /auth/refresh` | refresh JWT → 新しい access |
| `GET /runs`（同期 API・FR-02） | Bearer 必須。中身は **501** |
| `POST /bff/trends`（FR-10, C1） | Bearer 必須。OpenAlex 公開論文を OrcaRouter（gpt-4o-mini → gemini-2.5-flash → haiku、`fail_open: false`）で要約 |
| `POST /bff/bibliography`（C1） | Orca 安価モデルの構造化出力（ADR-0002）。OpenAlex は OA の直 PDF URL だけ。`worker/src/bibliography/`（domain / application / infrastructure） |
| `GET`/`POST` `/bff/{name}`（C2/C3） | Bearer 必須。同意・プレビュー未実装のため **501** |
| cron → Queues 投入 | 動く |
| Queue コンシューマ → D1 | 動く（ソースは OpenAlex 1 つ） |

## 構成

| 要素 | 使うもの | 理由 |
|---|---|---|
| HTTP | Hono + `@hono/zod-openapi` | 経路と OpenAPI を同じ定義から出す |
| 入力 | Zod | 境界で一回だけ検証する |
| SQL | Kysely（compile のみ）+ D1 `batch` | 1 実行 50 クエリに収める。kysely-d1 は使わない |
| 型 | `kysely-codegen`（`npm run codegen`） | 正本は migrations |
| JWT | `jose`。Worker は `Authorization: Bearer` のみ | トークン置き場はクライアント（ADR-0001） |
| 実行 | Workers（HTTP と cron を同居） | ランタイムを増やさない |
| 保存 | D1（`test` / `dev` / `prod` で分ける） | 公開データのみで量が小さい |
| 分散 | Queues（1 メッセージ = 1 プロジェクト × ソース） | CPU 10ms/実行 の回避 |
| 冪等 | KV | cron・Queues とも at-least-once |
| 秘密 | Workers Secrets | 鍵をクライアントに置かない（`C-06`） |

## 初回セットアップ（人が一度だけ）

```bash
cd worker
npm ci
just env                       # .dev.vars と worker/.env（無ければ example から）
# worker/.env に CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID を貼る（下）
npx wrangler whoami --env dev  # 「API Token」と ai-research-api-dev のあるアカウントであること
./scripts/bootstrap.sh dev     # D1 / Queue / DLQ / KV を作る（人が一度だけ）
```

`npx wrangler login`（OAuth）は使わない。手元の OAuth アカウントと CI のアカウントが違うと、
local の `secret put` や D1 操作が別アカウントに向かい、`ai-research-api-dev` が見えない。

出力された ID を `wrangler.jsonc` の該当箇所に貼る。
**ID は秘密ではないのでコミットしてよい。** 秘密は Workers Secrets と `worker/.env` だけに置く。

`prod` は加えて `env.prod.routes[0].pattern` を実際の独自ドメインにする。
`workers.dev` のままだとゾーンの WAF とレート制限が効かない（ADR-0004）。

### GitHub 側

Settings → Secrets and variables → Actions。**Secret と Variable はタブが違う。**

| 種別 | 名前 | 中身 |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | 下の権限を持つ API トークン。手元は `worker/.env` にも置く |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | アカウント ID（トークン設定後に `npx wrangler whoami --env dev`） |
| Secret | `JWT_SIGNING_KEY` | Worker の HS256 署名鍵。CI が `wrangler secret put` する |
| Secret | `ORCAROUTER_API_KEY` | OrcaRouter の `sk-orca-…`（C1 interactive）。CI が `wrangler secret put` する |
| Secret | `OPENALEX_API_KEY` | OpenAlex の無料 API キー。Workers 共有 IP では無鍵が落ちる |
| Secret | `JEV_API_KEY` | **使わない**（ADR-0002）。旧書誌経路の残骸。製品の前提にしない |
| Secret | `GOOGLE_OAUTH_CLIENT_ID` | Google OAuth の client_id（公開してよいが env ごとに分ける） |
| Secret | `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth の client_secret。Electron には置かない |
| Variable | `DEV_HEALTH_URL` | 例: `https://ai-research-api-dev.<sub>.workers.dev/health` |
| Variable | `TEST_HEALTH_URL` | 例: `https://ai-research-api-test.<sub>.workers.dev/health` |
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

#### 手元 wrangler（`.env`）

[API Tokens](https://dash.cloudflare.com/profile/api-tokens) で上の権限のトークンを作り、`worker/.env` に置く（gitignore）。

```
CLOUDFLARE_ACCOUNT_ID=…
CLOUDFLARE_API_TOKEN=…
```

`just env` が `.env.dev` / `.env.test` / `.env.prod` を `.env` へ張る。`wrangler --env X` は `.env` を読まず `.env.X` だけを読むため。

確認（値は出さない）:

```bash
npx wrangler whoami --env dev
```

「You are logged in with an API Token」になり、`ai-research-api-dev` があるアカウントであること。OAuth のままなら `.env` が空か、`--env` 用の symlink が無い。

GitHub の `CLOUDFLARE_API_TOKEN` は書き込み専用で引き戻せない。手元と CI で同じトークンを使うなら、発行時に両方へ入れる。

#### 環境ごとに分ける（推奨）

ワークフローは `environment: test` / `environment: dev` / `environment: prod` を使うので、
**Environment 単位で別の Secret を持てる**。dev 用トークンに prod を触らせない構成にできる。

Settings → Environments → `test` / `dev` / `prod` を作り、それぞれに `CLOUDFLARE_API_TOKEN` を置く。
リポジトリ全体の Secret より優先される。

`prod` は Environment で承認を必須にできる。誤 deploy を止める最後の砦。
`test` に承認は付けない（Claude scan の手動実行を止めないため）。

### Workers Secrets

`JWT_SIGNING_KEY` / `ORCAROUTER_API_KEY` / `OPENALEX_API_KEY` / `JEV_API_KEY` / `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` は **GitHub Secrets に置き、deploy が Worker へ載せる。**
手元 wrangler は `worker/.env` の API トークンを使う。OAuth（`wrangler login`）のアカウントと混ぜない。

```bash
gh secret set JWT_SIGNING_KEY
gh secret set ORCAROUTER_API_KEY
gh secret set OPENALEX_API_KEY
gh secret set JEV_API_KEY
gh secret set GOOGLE_OAUTH_CLIENT_ID
gh secret set GOOGLE_OAUTH_CLIENT_SECRET
```

OpenAlex のキーは [openalex.org/settings/api](https://openalex.org/settings/api) で無料発行。2026-02 以降、Workers のような共有 IP からの無鍵呼び出しは落ちる。

未設定なら認証系と C1 は 501。ログインの上流は Google OAuth（ADR-0004）。
Google Cloud Console で OAuth クライアント（種別 **Desktop**）を作る。Web だとポート固定の redirect が要り、Electron のランダムポートと合わない。
callback は `http://127.0.0.1`（ポートは問わない）。Consent が Testing なら自分の Google アカウントをテストユーザーに入れる。
実装前や client 未設定の間は `just token`。
`ORCAROUTER_API_KEY` は C1 トレンド（interactive）用。`ORCAROUTER_API_KEY_INTERACTIVE` があればそちらを優先。`cron` / `sensitive` は C2/C3 を足すときに分ける（ADR-0002）。
C1 の Orca model / fallback / temperature は `src/shared/orca/policy.ts`。書誌補完もこれ（ADR-0002）。ダッシュボードに依存しない。
スライスは `auth/` `bibliography/` `trend/` `collect/` `usage/`（いずれも domain / application / infrastructure）。HTTP は `src/http/`。
TypeSafe Jev は製品に使わない。経路は OpenAPI の path が決める。`hono-jev-router`（意味で振る実験ルーター）は使わない。Bearer と本文を経路判定で外に出さない。

クライアントは refresh を OS 保護領域（`safeStorage`）、access をメモリに置く（ADR-0001）。
Worker は Cookie を出さない。

Worker が読むバインディングは `DB` / `IDEMPOTENCY` / `COLLECT_QUEUE` と
`ENVIRONMENT` / `CONSENT_VERSION` / `LLM_DAILY_CALL_LIMIT`（vars）。秘密は Secrets のみ。

## CI/CD

[.github/workflows/deploy-worker.yml](../.github/workflows/deploy-worker.yml)。
ブランチ規約（`AGENTS.md`: feature → `dev` → `main`）に合わせてある。

| 契機 | やること |
|---|---|
| PR → `dev` / `main` | `validate` のみ。deploy しない |
| push → `dev` | migrations → deploy（`--env dev`）→ 疎通確認 |
| push → `main` | migrations → deploy（`--env prod`）→ 疎通確認 |
| 手動 `target=test` | bootstrap（冪等）→ seed → deploy（`--env test`）。push では載らない |
| 手動 `target=dev` / `prod` | 選んだ環境へ deploy |

`validate` の中身:

1. `database_id` / KV `id` が `PLACEHOLDER_` のままだったら落とす
2. `wrangler types` → `tsc --noEmit`
3. `wrangler deploy --dry-run` を dev / prod の両方

**マイグレーションを deploy より先に当てる。** 逆にすると、新しい列を読むコードが
列の無い DB に当たる時間が生まれる。

**dev / prod のインフラ作成は CI でやらない。** 毎回の push で作ると事故が戻せない。
**test は隔離環境なので**、手動 deploy-test が `bootstrap.sh test` を冪等に走らせてよい。

Claude Scan の `router-retro` は `d1-retro/` の集計 JSON を読む。手動実行の既定は `d1_target=test`。
定時は `live`（dev + prod）。Cloudflare のトークンは Claude に渡さない。

### 戻し方

自動ロールバックはしない。失敗時はログに手順が出る。

```bash
cd worker && npx wrangler rollback --env prod
```

`JWT_SIGNING_KEY` は `/auth/refresh` と Bearer 検証で使う。Google の client が空なら `GET`/`POST` `/auth/google` は 501。

## ローカル

入口はリポジトリ直下の `just`（未導入なら `brew install just`）。
GitHub の Secret は**引き戻せない**。有料キーは `worker/.dev.vars` に一度書く（gitignore。`C-06`）。

```bash
just env                 # .dev.vars + local D1
# worker/.dev.vars に ORCAROUTER_API_KEY / OPENALEX_API_KEY を貼る
just worker              # http://127.0.0.1:8787
just seed-worker         # ローカル D1 に機能紹介用 seed（ok/empty/failed/partial）
# 別端末
just verify              # /health と POST /bff/bibliography（Bearer 無しは 401）
just seed-staging        # Cloudflare 上の D1 dev。prod には当てない
```

Google ログイン前は access JWT を `just token` がローカル鍵で署名する。
Orca のキーが空なら C1 は **501**（無い鍵で動いたふりをしない）。

既定は `--env dev`。トップレベルの wrangler 設定は空なので、env 無しではバインディングが無い。

```bash
npx wrangler dev --test-scheduled --env dev    # cron を叩く: /__scheduled
npm run codegen                                # migrations から Kysely の型
```

## Free 枠で効く制約（ADR-0004）

コードを変えるときはこれを壊していないか見る。

- **CPU 10ms / 1 実行。** 粗い採点は文字列一致の水準に留める（`coarseScore`）
- **サブリクエスト 50 / 1 実行。** ページングは次のメッセージへ回す
- **D1 は 1 実行 50 クエリ。** `run_papers` は 20 行ずつ 1 文にまとめている
- **cron はアカウントで 5 本。** 日次収集は `dev` / `prod` の各 1 本。`test` には付けない
- **UTC のみ。** 夏時間の影響を受けない時刻を選ぶ

## 未対応

- **WAF・レート制限がコード管理になっていない。** ADR-0004 は「wrangler / Terraform で
  コード管理」としているが、これらはゾーンの設定で wrangler では扱えない。Terraform が要る
- 認証（OAuth + PKCE、署名鍵の入れ替え）
- C2 テーマ候補・C3 ファクトチェック（同意・プレビュー）
- `runs` / `run_papers` の保持期間の削除処理
