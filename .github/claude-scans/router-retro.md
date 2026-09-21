# ルーター内省スキャン（運用実績）

`.github/claude-scans/shared.md` を先に Read。**いまは `proposal` のみ。`auto-scan` を付けない。**

対象は ADR-0005（`docs/adr/0005-cloud-trend-survey-model-tiering.md`）。
モデル選択・検索クエリ・段数は ADR の決定なので、設定を自分で変えない。提案だけ出す。
（`proposal` は初期設定。提案の質を PR で見たうえで `auto-scan` へ上げるかを別途決める）

**回す頻度に制限はない。1 日に何回回してもよい。**
代わりに**母数のガードをここに置く**——データが足りないまま提案を出さない。

- 見る範囲は環境変数 `LOOKBACK_DAYS`（既定 7）日分
- **その範囲の run 数・論文数が少なすぎるときは issue を出さない。**
  「n がいくつだったから出さなかった」を出力して終わる
- **前回の実行から D1 に新しい run が増えていなければ、何も出さない。**
  同じデータを見て同じ提案を作り直さない（shared.md の重複禁止）

## 指標はスクリプトから取る

**D1 の生データを読んで印象で語らない。**`scripts/retro-metrics` を実行し、
出力された集計値 JSON だけを根拠にする。

- スクリプトが無い／失敗する／`CLOUDFLARE_ACCOUNT_ID`・`CLOUDFLARE_API_TOKEN` が空
  → **issue を出さない。**何を試してなぜ取れなかったかを出力して終わる（`未確認は書かない`）
- **`SELECT` だけを投げる。書き込むクエリを実行しない。**
  渡されるトークンは deploy と共用で書き込み権限を持つ（`CLOUDFLARE_API_TOKEN`）。
  読み取りだけに使うのはこちらの責任になる
- 閾値の比較はスクリプトの結果に従う。**同じ入力なら同じ判定になること**

### D1 の database_id

**Secret にしない。**`worker/wrangler.jsonc` に書いてあり、同ファイルが
「D1 / KV / Queue の ID は秘密ではない」と明記している。環境名から引く:

```
DB_ID=$(sed 's@^[[:space:]]*//.*@@' worker/wrangler.jsonc \
  | jq -r --arg e dev '.env[$e].d1_databases[0].database_id')
```

`PLACEHOLDER_` が返ったら未構築とみなし、issue を出さずに降りる。

参考（スクリプトが内部で使う API。権限は `D1 Read` で足りる）:

```
curl https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/d1/database/$DB_ID/query \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"sql":"..."}'
```

## 出してよい情報

- **prod からは集計値だけ。**`summary` の本文・生成された検索語の文字列・論文の要旨を issue に書かない
- クエリ文言そのものの良し悪しを論じるときは **dev の D1 だけ**を使う
- shared.md の「未公開研究の記載」禁止を継承する

## 調べる対象

1. **前回提案の効果**（最優先）。過去の `proposal,router` のうち採用されたものについて、
   **採用前後の `cost_usd` と捏造率を並べる。効果が出ていなければ差し戻しを提案する**
2. **効率**: **トークン/論文・コスト/論文・コスト/レビュー済み論文**。
   **比率と取得本数（絶対値）を必ず並べる。本数が減って比率が良くなったのは改善ではない**
3. **モデル選択**: 捏造率（`evidence` 照合の失敗率）・形式違反率・`unclear` 率・
   所要時間・自前フォールバックの発生率と落とし先。`rs-review` の Default を変える根拠があるか
4. **検索クエリ**: クエリ別の取得件数・重複率・0 件率・ソース別失敗率・2 段目への到達率
5. **段数**: 1 段目 → 2 段目の到達率と `unclear` 率。**2 段に分ける前提が崩れていないか**
6. **無料枠**: 解決モデルが無料だった率・受け皿へ落ちた率。
   `rs-collect` が無料前提のまま成立しているか
7. **ループ自身のコスト**: `llm_calls` の `endpoint = retro`。本体に対する比率

## 出さないもの

- `routers/*.yaml` の自動変更。**差分案は issue の本文に書くまで**
- n が小さいときの断定。**件数を必ず併記する**
- `C-09` 採点を外部 LLM に出す提案（shared.md の禁則）
- 候補の除外・削除の提案（`C-07`。`competing` / `usable` は**読み方の区別**であって除外の軸ではない）
- 実装が無いこと自体（shared.md）

## issue

`proposal,router`。**上限 3（暫定値。運用で見直す）**。
引用必須（`scripts/retro-metrics` の出力値と、根拠にした期間・件数を貼る）。
0 件なら、何を見てなぜ出さなかったかを出力する。
