# アーキテクチャ決定記録 (ADR)

**何を作るか**は [docs/requirements/00-goals.md](../requirements/00-goals.md) と要件一式。
**どう作るか**が本ディレクトリ。

## ゴール成功条件 → ADR

| 成功条件 (00-goals) | 要件 | 主な ADR |
|---|---|---|
| 1. 日次で新着が溜まる（起動不要） | FR-01 | 0002, 0004, 0009 |
| 2. 重複・活用可能性の報告 | FR-02, FR-03 | 0003, 0004 |
| 3. Zotero に保存 | FR-05 | 0014, 0015 |
| 4. 原稿ファクトチェック | FR-04, FR-07 | 0010, 0013 |
| 5. 外部 LLM を統制下で呼ぶ | FR-10 | 0007, 0008, 0010 |
| 6. 次のテーマ候補 | FR-09 | 0016, 0004, 0007 |

制約（`C-01`〜`C-07`）は成功条件ではなく [02-constraints.md](../requirements/02-constraints.md)。

## 一覧

| # | タイトル | ステータス |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | アーキテクチャ決定を ADR として記録する | 承認済み |
| [0002](0002-cloud-cron-plus-desktop-client-split.md) | 定期実行はクラウド、対話処理はデスクトップに分離する | 承認済み |
| [0003](0003-local-only-rag-with-local-embeddings.md) | RAG はローカル完結とし、埋め込みもローカルで推論する | 承認済み |
| [0004](0004-two-stage-relevance-filter.md) | 関連度判定を二段フィルタにする | 承認済み |
| [0005](0005-electron-typescript-single-language-stack.md) | Electron + TypeScript で統一し、Python を必須依存にしない | 承認済み |
| [0006](0006-separate-vector-spaces-per-embedding-model.md) | 埋め込みモデルごとにベクトル空間を分離する | **置き換え済み (ADR-0012)** |
| [0007](0007-orcarouter-as-llm-gateway.md) | LLM 呼び出しを OrcaRouter ゲートウェイ経由に統一する | 承認済み |
| [0008](0008-bff-for-auth-ratelimit-and-cost.md) | BFF を挟み、認証・レート制限・コスト統制をサーバ側で行う | 承認済み |
| [0009](0009-domain-agnostic-plugin-architecture.md) | 分野固有の知識を設定とアダプタに外出しする | 承認済み |
| [0010](0010-data-classification-for-llm-calls.md) | LLM に送るデータを分類し、分類ごとに経路と統制を変える | 承認済み |
| [0011](0011-degradation-and-resilience.md) | 障害時は段階的に縮退させ、無言で失敗しない | 承認済み |
| [0012](0012-config-driven-embedding-spaces.md) | 埋め込み空間を設定駆動にする | 承認済み |
| [0013](0013-manuscript-input-adapters-and-factcheck-pipeline.md) | 原稿入力をアダプタ化し、ファクトチェックを 2 段 LLM で行う | 承認済み |
| [0014](0014-zotero-local-api-primary.md) | Zotero 連携はローカル API を主、Web API を副とする | 承認済み（§3 は ADR-0015） |
| [0015](0015-zotero-oauth-via-bff.md) | Zotero 接続に OAuth 1.0a、Client Secret は BFF | 承認済み |
| [0016](0016-theme-candidates-on-desktop.md) | テーマ候補はデスクトップ側 LLM が生成する | 承認済み |

## 決定の相互関係

```
ゴール成功条件
  1 ──→ ADR-0002 クラウド cron ──┐
                                 ├─→ ADR-0004 二段フィルタ
  2 ──→ ADR-0003 ローカル RAG ───┘
  5 ──→ ADR-0007 Orca ──→ ADR-0008 BFF ──→ ADR-0010 分類
  4 ──→ ADR-0013 ファクトチェック（C3）
  6 ──→ ADR-0016 テーマ候補（既定 C2）
  3 ──→ ADR-0014 保存経路 ──→ ADR-0015 OAuth
  分野横断 ──→ ADR-0009 / 0012
  障害 ──→ ADR-0011
```

## 貫かれている原則

[02-constraints.md](../requirements/02-constraints.md) を設計で守る。

1. `C-01` 未公開の恒久外部インデックス禁止（ADR-0003）
2. `C-04` 外部 LLM は分類統制下（ADR-0010）。埋め込みとプロンプトは別物
3. `C-03` C3 は無効化可能。秘匿性優先可
4. `C-07` 無言で失敗しない（ADR-0011）
5. `C-05` 分野知識をコアに埋め込まない（ADR-0009）
6. `C-06` 開発者有料キーをクライアントに置かない（ADR-0008）

## 未決事項（アーキ）

- ローカル LLM による C3（要件更新のうえ別 ADR）
- 論文ソースの初期実装セットと優先順位
- Cron 時刻、D1 保持期間
- 分野別プリセット内容（ADR-0012）

プロダクト未決は [05-open-questions.md](../requirements/05-open-questions.md)。

## 新しい ADR を追加する

1. `NNNN-kebab-case-title.md`
2. コンテキストにゴール成功条件と要件 ID を書く
3. 本 README とルート README の表を更新
4. 決定を覆すときは新 ADR＋旧ステータス `置き換え済み`
