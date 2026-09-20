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

| 種別 | 名前 | 中身 |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | Workers / D1 / KV / Queues の編集権限 |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | アカウント ID |
| Variable | `DEV_HEALTH_URL` | 例: `https://ai-research-api-dev.<sub>.workers.dev/health` |
| Variable | `PROD_HEALTH_URL` | 例: `https://api.example.com/health` |

`*_HEALTH_URL` は任意。未設定なら疎通確認は警告を出して飛ばす（deploy 自体は成功扱い）。

`prod` は GitHub の Environment で承認を必須にできる。誤 deploy を止める最後の砦。

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
