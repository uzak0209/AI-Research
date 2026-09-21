# 機能紹介用 seed

Electron の空画面と、staging（D1 `dev`）の空の収集履歴を、**同じ公開論文の物語**で埋める。
未公開の研究は入れない（`C-01`）。id は `seed-` で始まる行だけを触る。

正本は [catalog.json](catalog.json)。関連度は [judge-bench の実測](../prototypes/judge-bench/results/ranked-real.json)（`bge-small-en-v1.5`）。有効／除外は断定しない（`C-07`）。

```bash
just seed-desktop     # Electron の userData SQLite
just seed-staging     # Cloudflare D1 ai-research-dev（--remote）
just seed-worker      # ローカル wrangler D1
```

Electron は入れたあと**起動し直す**。起動中だと WAL で古い画面が残ることがある。

## 見せるもの

デモプロジェクトは「低データ分子物性予測の GNN」。課題意識はクラウド収集材料。関連技術はローカル採点（＋収集語彙）用。

| 画面 | 入っているもの |
|---|---|
| ライブラリ | 6 件。★ 2 / 未読 3 / 読んでいる 1 / 読んだ 2。タグ（転移学習・不確実性・手法・競合・解釈）。メモ 3 件。本 1 冊（`item_type=book`） |
| 新着候補 | 採点済み 8 件（関連度順）＋**未採点 2 件**（実数で出す）。1 位はライブラリ済。7 位は MD ポテンシャルで「競合」タグ。最下位はロボット論文でも候補から消さない |
| プロジェクト | 課題意識と関連技術 6 行。新着の「最も近い関連技術」の出典 |
| staging D1 | `ok` / `empty` / `failed` / `partial` の 4 実行（FR-08）。`failed` は 429、`empty` は 0 件 |

「採点する」を押すと未採点 2 件だけが埋まる。済んだ 8 件は触らない。

staging の所有者はデモユーザー `seed-demo`（`oauth_subject=google:seed-demo`）。自分の Google ログインとは別行。cron の収集対象にはなる（公開 summary のみ）。

`just seed-staging` は **D1 を持つ Cloudflare アカウント** の API トークンが `worker/.env` にあること（`npx wrangler whoami --env dev`）。手元の OAuth アカウントと `wrangler.jsonc` の `database_id` が違うと `code: 7404` で拒否される。その場合は CI と同じアカウントのトークンを置くか、`just seed-worker` でローカル D1 を見る。

## 入れ直す・消す

同じコマンドをもう一度走らせると `seed-demo` だけ入れ直す。中身のある利用者プロジェクトは消さない。
空の「新しいプロジェクト」だけは、UI が一覧の先頭しか出さないため外す。

staging から外すとき:

```bash
cd worker
npx wrangler d1 execute ai-research-dev --env dev --remote --yes \
  --command "DELETE FROM users WHERE user_id = 'seed-demo'"
```

（FK で projects / runs / run_papers も消える）
