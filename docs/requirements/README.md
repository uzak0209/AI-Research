# 要件 (Requirements)

「何を・なぜ作るか」を記録する。**どう作るかは書かない** — それは [ADR](../adr/) の役割。

## 要件と ADR の関係

| | 要件 (`docs/requirements/`) | ADR (`docs/adr/`) |
|---|---|---|
| 問うこと | 誰が何を必要とし、何ができれば成功か | それをどう実現するか |
| 書いてよい例 | 「アプリ未起動でも日次で新着を集めたい」 | Cloudflare Workers + Cron |
| 書いてはいけない例 | Electron / LanceDB / モデル名 | 「ユーザーはトレンドを追いたい」 |

技術名が要件に入ってよいのは、**利用者が選ぶ外部ツールとの接続がプロダクト条件のときだけ**
（例: Zotero に保存する）。実装スタックは ADR 側に置く。

作業順は常に **要件を確認 → 必要なら要件を更新 → ADR で手段を決める**。
要件に無い機能を ADR や実装から生やさない。

## 一覧

| 文書 | 内容 |
|---|---|
| [00-goals.md](00-goals.md) | 背景・対象ユーザー・成功条件 |
| [01-functional.md](01-functional.md) | 機能要件 (`FR-xx`) |
| [02-constraints.md](02-constraints.md) | 守るべき制約 (`C-xx`) |
| [03-non-functional.md](03-non-functional.md) | 非機能要件 (`NFR-xx`) |
| [04-out-of-scope.md](04-out-of-scope.md) | やらないこと |
| [05-open-questions.md](05-open-questions.md) | プロダクトとして未決のこと |
| [06-feature-candidates.md](06-feature-candidates.md) | 機能候補（未採択） |

## ID の付け方

- 機能: `FR-01`, `FR-02`, …
- 制約: `C-01`, `C-02`, …
- 非機能: `NFR-01`, …
- 未決の問い: `OQ-01`, …

ADR のコンテキストからは、これらの ID を参照する。

## 更新ルール

- 要件を変えるときはこのディレクトリを先に更新する。ADR だけ書き換えて要件を黙って変えない
- 制約に反する実装・ADR 提案をしてはいけない。覆すなら先に要件側で議論する
- アーキテクチャ上の未決（どのライブラリか、Cron の時刻など）は
  [`docs/adr/README.md`](../adr/README.md) の未決事項に置く。ここには置かない
