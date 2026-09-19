# AI-Research

研究トレンドの自動追跡システム。毎日自動で最新論文を収集・解析し、自分の研究との重複や活用可能性を報告し、Zotero に参考文献を保存する。

> **状態**: 設計フェーズ。実装は未着手。現時点のリポジトリ内容はアーキテクチャ決定記録 (ADR) のみ。

## 背景

研究の際に毎回手作業で行っていた以下を自動化することが目的。

- 最新のトレンド調査
- 自分の研究と被っていないかの確認
- 自分の研究に活用できそうな論文の発見

## 構想している機能

- **日次の論文収集とトレンド解析** — 1日1回自動実行。ユーザーがアプリを起動していなくても動く
- **重複研究の検出** — 新着論文が自分の研究と被っていないかの判定
- **Zotero 連携** — 関連論文を参考文献として保存
- **原稿のファクトチェック** — 執筆中の内容が最新論文と矛盾していないかの検査（定期実行・手動実行）
- **研究データの RAG 化** — 自分の研究データ・過去のデータを検索可能にする

## アーキテクチャの概要

処理を2層に分離している。

**クラウド層 (Cloudflare Workers + Cron Triggers + D1)**
日次で論文を収集し、粗い関連度スコアリングを行ってレポートを D1 に蓄積する。ユーザーの起動状態に依存しない。

**デスクトップ層 (Electron + TypeScript)**
起動時に D1 から未取得のレポートをプルし、ローカル RAG で精密な判定を行う。Zotero 保存とファクトチェックもここ。

```
                 ┌──────────────────────────────┐
  論文ソース  ──→│ Cloudflare Workers (日次cron)│
  (arXiv 等)     │   粗いフィルタ・スコアリング  │
                 └──────────────┬───────────────┘
                                │ 日次レポート
                         ┌──────▼──────┐
                         │  D1 (蓄積)  │
                         └──────┬──────┘
                                │ 起動時にプル
                 ┌──────────────▼───────────────┐
                 │   Electron デスクトップアプリ │
                 │  ローカル RAG で精密判定      │
                 │  Zotero 保存 / ファクトチェック│
                 └──────────────┬───────────────┘
                                │
                    ┌───────────▼────────────┐
                    │ LanceDB (ローカルのみ) │
                    │ 未公開の研究データ     │
                    └────────────────────────┘
```

### 設計上の原則

**未公開の研究データはローカルに留める。** 実験データ、実験ノート、投稿前の原稿はネットワークに出さない。埋め込み生成もローカルモデル (Transformers.js + ONNX Runtime) で行い、埋め込み API は使わない。

クラウドに置くのは、自分で書いた公開可能な研究概要・キーワード・論文識別子のみ。この制約から「クラウドで粗く、ローカルで精密に」の二段フィルタ構成が導かれている。

## 技術スタック（予定）

| 領域 | 選定 |
|---|---|
| 定期実行 | Cloudflare Workers + Cron Triggers |
| レポート蓄積 | Cloudflare D1 |
| デスクトップ | Electron + TypeScript |
| 埋め込み推論 | Transformers.js (ONNX Runtime / WebGPU) |
| ベクトル DB | LanceDB (ローカル) |
| 論文ベクトル | Semantic Scholar API (specter2) |

Python は実行時の必須依存にしない。

## ドキュメント

設計判断の経緯は [docs/adr/](docs/adr/) に記録している。

| # | 決定 |
|---|---|
| [0001](docs/adr/0001-record-architecture-decisions.md) | アーキテクチャ決定を ADR として記録する |
| [0002](docs/adr/0002-cloud-cron-plus-desktop-client-split.md) | 定期実行はクラウド、対話処理はデスクトップに分離する |
| [0003](docs/adr/0003-local-only-rag-with-local-embeddings.md) | RAG はローカル完結とし、埋め込みもローカルで推論する |
| [0004](docs/adr/0004-two-stage-relevance-filter.md) | 関連度判定を二段フィルタにする |
| [0005](docs/adr/0005-electron-typescript-single-language-stack.md) | Electron + TypeScript で統一し、Python を必須依存にしない |
| [0006](docs/adr/0006-separate-vector-spaces-per-embedding-model.md) | 埋め込みモデルごとにベクトル空間を分離する |

ADR-0002・0003・0004 は相互に依存しているため一体で読むこと。詳細は [docs/adr/README.md](docs/adr/README.md)。

## 未決事項

- 論文ソースの選定 (arXiv / Semantic Scholar / OpenAlex / Crossref / PubMed)
- 埋め込みモデルの最終選定 (`multilingual-e5-large` か `bge-m3`)
- 原稿ファクトチェックの入力方式 (ローカルファイル監視 / Overleaf git bridge / 手動)
- Zotero 連携の方式 (ローカル API か Web API)
- Cron の実行時刻、D1 のレポート保持期間

論文ソースと埋め込みモデルは対象研究分野に依存するため、分野確定後に ADR として決定する。
