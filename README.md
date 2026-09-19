# AI-Research

研究トレンドの自動追跡システム。毎日自動で最新論文を収集・解析し、自分の研究との重複や活用可能性を報告し、Zotero に参考文献を保存する。

> **状態**: 設計フェーズ。実装は未着手。リポジトリの中心は **要件** と **ADR**。

## ドキュメントの読み方

| 置き場 | 役割 |
|---|---|
| [docs/requirements/](docs/requirements/) | **何を・なぜ**（機能・制約・未決の問い） |
| [docs/adr/](docs/adr/) | **どう作るか**（アーキテクチャ決定） |

先に要件、次に ADR。手段だけ先に増やさない。

## 背景（要約）

正本は [docs/requirements/00-goals.md](docs/requirements/00-goals.md)。

手作業のトレンド調査・重複確認・有用論文の発見・**次のテーマ候補**を自動化する。
Zotero 利用は前提。外部 LLM の統制された利用自体も目的に含む。
成功条件はゴール文書の 1〜6。制約は [02-constraints.md](docs/requirements/02-constraints.md)。

## アーキテクチャの概要

処理を2層に分離している（[ADR-0002](docs/adr/0002-cloud-cron-plus-desktop-client-split.md)）。

**クラウド層 (Cloudflare Workers + Cron Triggers + D1)**
日次で論文を収集し、粗い関連度スコアリングを行ってレポートを D1 に蓄積する。ユーザーの起動状態に依存しない。

**デスクトップ層 (Electron + TypeScript)**
起動時に D1 から未取得のレポートをプルし、ローカル RAG で精密判定、
テーマ候補生成、Zotero 保存、ファクトチェックを行う。

```
  論文ソース      ┌──────────────────────────────┐
  (アダプタ) ───→│ Cloudflare Workers (日次cron)│
  arXiv/S2/...    │   粗いフィルタ・スコアリング  │
                  └──────────────┬───────────────┘
                                 │ 日次レポート
                          ┌──────▼──────┐
                          │  D1 (蓄積)  │
                          └──────┬──────┘
                                 │ 起動時にプル
                  ┌──────────────▼───────────────┐      ┌─────────────┐
                  │   Electron デスクトップアプリ │─────→│ BFF(Workers)│
                  │  ローカル RAG で精密判定      │ OAuth└──────┬──────┘
                  │  Zotero 保存 / ファクトチェック│             │ API キー
                  └──────────────┬───────────────┘      ┌──────▼──────┐
                                 │                      │ OrcaRouter  │
                     ┌───────────▼────────────┐         └──────┬──────┘
                     │ LanceDB (ローカルのみ) │                │
                     │ 未公開の研究データ     │         各LLMプロバイダ
                     └────────────────────────┘
```

プロダクト制約（未公開データの扱い・配布・欠損の可視化など）は
[docs/requirements/02-constraints.md](docs/requirements/02-constraints.md)。
それらをどう守るかは ADR（特に 0003・0007・0008・0010・0011）を参照。

## 技術スタック（予定）

| 領域 | 選定 | 根拠 |
|---|---|---|
| 定期実行 | Cloudflare Workers + Cron Triggers | ADR-0002 |
| レポート蓄積 | Cloudflare D1 | ADR-0002 |
| デスクトップ | Electron + TypeScript | ADR-0005 |
| LLM ゲートウェイ | OrcaRouter | ADR-0007 |
| BFF / 認証 | Workers + OAuth 2.0 + PKCE | ADR-0008 |
| 埋め込み推論 | Transformers.js（ローカル） | ADR-0003 |
| ベクトル DB | LanceDB（ローカル） | ADR-0003 |
| 論文ソース | アダプタ方式 | ADR-0009 |

Python は実行時の必須依存にしない（ADR-0005）。

## ADR 一覧

| # | 決定 |
|---|---|
| [0001](docs/adr/0001-record-architecture-decisions.md) | アーキテクチャ決定を ADR として記録する |
| [0002](docs/adr/0002-cloud-cron-plus-desktop-client-split.md) | 定期実行はクラウド、対話処理はデスクトップに分離する |
| [0003](docs/adr/0003-local-only-rag-with-local-embeddings.md) | RAG はローカル完結とし、埋め込みもローカルで推論する |
| [0004](docs/adr/0004-two-stage-relevance-filter.md) | 関連度判定を二段フィルタにする |
| [0005](docs/adr/0005-electron-typescript-single-language-stack.md) | Electron + TypeScript で統一し、Python を必須依存にしない |
| [0006](docs/adr/0006-separate-vector-spaces-per-embedding-model.md) | ~~埋め込みモデルごとにベクトル空間を分離する~~ (ADR-0012 が置き換え) |
| [0007](docs/adr/0007-orcarouter-as-llm-gateway.md) | LLM 呼び出しを OrcaRouter ゲートウェイ経由に統一する |
| [0008](docs/adr/0008-bff-for-auth-ratelimit-and-cost.md) | BFF を挟み、認証・レート制限・コスト統制をサーバ側で行う |
| [0009](docs/adr/0009-domain-agnostic-plugin-architecture.md) | 分野固有の知識を設定とアダプタに外出しする |
| [0010](docs/adr/0010-data-classification-for-llm-calls.md) | LLM に送るデータを分類し、分類ごとに経路と統制を変える |
| [0011](docs/adr/0011-degradation-and-resilience.md) | 障害時は段階的に縮退させ、無言で失敗しない |
| [0012](docs/adr/0012-config-driven-embedding-spaces.md) | 埋め込み空間を設定駆動にする |
| [0013](docs/adr/0013-manuscript-input-adapters-and-factcheck-pipeline.md) | 原稿入力をアダプタ化し (.tex/.md/.typ)、ファクトチェックを 2 段 LLM で行う |
| [0014](docs/adr/0014-zotero-local-api-primary.md) | Zotero 連携はローカル API を主、Web API を副とする |
| [0015](docs/adr/0015-zotero-oauth-via-bff.md) | Zotero 接続に OAuth 1.0a を採り、Client Secret は BFF に置く |
| [0016](docs/adr/0016-theme-candidates-on-desktop.md) | テーマ候補はデスクトップ側 LLM が生成する |

詳細とゴール対応表は [docs/adr/README.md](docs/adr/README.md)。

## 未決事項

- **プロダクト** — [docs/requirements/05-open-questions.md](docs/requirements/05-open-questions.md)
- **アーキテクチャ** — [docs/adr/README.md](docs/adr/README.md) の未決事項
