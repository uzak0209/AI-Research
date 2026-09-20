# テストを通らないと進めなくする

**GitHub Actions は push の後に走るので、Actions だけでは `git push` を止められない。**
止める場所が 2 つあり、役割が違う。

| 層 | 止めるもの | 迂回 | 設定 |
|---|---|---|---|
| pre-push フック | ローカルの `git push` | `--no-verify` で抜けられる | クローンごとに 1 回 |
| ブランチ保護 | リモートへの push とマージ | 抜けられない（管理者を除く） | リポジトリに 1 回 |

**フックは速く気づくため、保護は確実に止めるため。** 片方だけでは足りない。

## 1. pre-push フック

```bash
git config core.hooksPath .githooks
```

git はフックをリポジトリで共有しないので、**クローンごとに 1 回必要**。

[.githooks/pre-push](../.githooks/pre-push) がやること:

1. `main` への直 push を拒否（`AGENTS.md`）
2. push される範囲に `worker/` の変更が無ければ以降を飛ばす
3. `wrangler.jsonc` に `PLACEHOLDER_` が残っていたら拒否
4. `tsc --noEmit` → `vitest run` → `wrangler deploy --dry-run`（dev / prod）

変更の判定は git が渡す `<remote sha>..<local sha>` で行う。
作業ツリーの未コミット分は push されないので見ない。

## 2. ブランチ保護（required status checks）

`validate` を必須チェックにする。これが通らない限り `dev` / `main` へマージできない。

### 画面から

Settings → Branches → Add branch protection rule

| 対象 | 設定 |
|---|---|
| `dev` | Require status checks → `validate` / Require PR before merging |
| `main` | 同上 ＋ Do not allow bypassing / Restrict who can push |

### gh CLI から

```bash
# dev
gh api -X PUT repos/:owner/:repo/branches/dev/protection \
  -f 'required_status_checks[strict]=true' \
  -f 'required_status_checks[contexts][]=validate' \
  -f 'enforce_admins=false' \
  -F 'required_pull_request_reviews=null' \
  -F 'restrictions=null'

# main は dev からの PR のみ（AGENTS.md）。bypass を許さない
gh api -X PUT repos/:owner/:repo/branches/main/protection \
  -f 'required_status_checks[strict]=true' \
  -f 'required_status_checks[contexts][]=validate' \
  -f 'enforce_admins=true' \
  -f 'required_pull_request_reviews[required_approving_review_count]=1' \
  -F 'restrictions=null'
```

`strict=true` は「base の最新を取り込んでいないと merge させない」。
古い状態で通ったチェックを根拠にさせないため。

### 注意: パスフィルタとの相性

[deploy-worker.yml](../.github/workflows/deploy-worker.yml) は `paths` で `worker/**` に
絞ってある。**必須チェックにすると、`worker/` を触らない PR で `validate` が起動せず、
"Expected — Waiting for status" のまま止まる**ことがある。

どちらかを選ぶ:

- `paths` を外して常に走らせる（数十秒のコストを払う）
- `validate` を必須にせず、`worker/` を触る PR だけ人が確認する

初版は**前者**を勧める。止まって困る方が、気づかず通る方より安い。

## 何をテストしているか

[worker/test/worker.test.ts](../worker/test/worker.test.ts) の 18 件。
Workers ランタイム上で実際の D1 に対して走る（Node で動かすと挙動がずれる）。

重点は「動くこと」より **`FR-08` / `C-07`（欠損を成功と偽らない）** が壊れていないこと。

- `0 件` と `取得失敗` を混ぜていないか
- 未実装の経路が空配列を返して「0 件」に見せかけていないか
- 欠けたソースが `failed_sources_json` に残るか
- 同じ日の再実行で `partial` に倒れるか
- D1 の 1 実行 50 クエリ・バインド上限に収まっているか

実際にこの仕組みで**本番バグを 1 件見つけた**。
`run_papers` を 20 行ずつ 1 文にまとめていたが、20 × 8 列 = 160 で
D1 のバインド変数上限 100 を超えていた。13 件以上取得した時点で落ちる。
列数から逆算する形に直してある。
