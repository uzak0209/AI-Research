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

### 設計上の原則

**1. 未公開データの恒久的なインデックスを外部に作らない。** 埋め込み生成はローカルモデル (Transformers.js + ONNX Runtime) のみで行い、埋め込み API は使わない。ベクトル DB もローカル。

**2. LLM 推論はデータ分類に応じた統制の下でのみ外部へ出す。** 埋め込み（全データを網羅的・恒久的に蓄積）とプロンプト（必要範囲を都度送信）はリスクの性質が異なるため、扱いを分けている。この非対称性は意図的なもので、[ADR-0003](docs/adr/0003-local-only-rag-with-local-embeddings.md) の適用範囲節と [ADR-0010](docs/adr/0010-data-classification-for-llm-calls.md) に根拠を記録している。

データは 3 段階に分類する。公開論文のみの処理 (C1) はコスト最適化を優先して自動ルーティングを使う。未公開の原稿を含む処理 (C3) はモデルを固定し、自動フォールバックを無効化し、送信範囲を最小化し、明示的な同意を取る。**C3 機能は完全に無効化できる**（機関規定で外部送信できない利用者のため）。

> ゲートウェイのゼロデータ保持は**ゲートウェイ自社サーバのみ**が対象で、上流プロバイダは各自の保持ポリシー（OpenAI / Anthropic は約 30 日の不正利用ログ）に従う。「ゲートウェイがゼロ保持だから残らない」とは説明できない。詳細は ADR-0010。

**3. API キーをクライアントに置かない。** OrcaRouter の認証は API キーのみなので、デスクトップに同梱すれば必ず抽出される。BFF を挟み、キーは Workers Secrets にのみ置く。

**4. 無言で失敗しない。** 日次 cron は誰も見ていない時間に走るため、「新着 0 件」と「障害で取得できず 0 件」を必ず区別して表示する ([ADR-0011](docs/adr/0011-degradation-and-resilience.md))。

**5. 分野固有の知識をコードに埋め込まない。** 論文ソースはアダプタ、埋め込みモデルは設定。どの分野のどの論文を書くときにも使えることを目標にする ([ADR-0009](docs/adr/0009-domain-agnostic-plugin-architecture.md))。

## 技術スタック（予定）

| 領域 | 選定 |
|---|---|
| 定期実行 | Cloudflare Workers + Cron Triggers |
| レポート蓄積 | Cloudflare D1 |
| デスクトップ | Electron + TypeScript |
| LLM ゲートウェイ | **OrcaRouter** (OpenAI 互換エンドポイント) |
| BFF / 認証 | Cloudflare Workers + OAuth 2.0 (GitHub / Google) + PKCE |
| 埋め込み推論 | Transformers.js (ONNX Runtime / WebGPU)、ローカルのみ |
| ベクトル DB | LanceDB (ローカル) |
| 論文ソース | アダプタ方式 (arXiv / Semantic Scholar / OpenAlex / ...) |

Python は実行時の必須依存にしない。

### OrcaRouter の活用点

LLM 呼び出しは単一の OpenAI 互換エンドポイントに統一している ([ADR-0007](docs/adr/0007-orcarouter-as-llm-gateway.md))。

- **スコープ付きキー**を用途ごとに分離 (`cron` / `interactive` / `sensitive`)。1 つのキーの漏洩・暴走が他に波及しない
- **Routing DSL** で、機密データを扱う処理は単一モデルに固定。公開データのみの処理は自動選択でコスト最適化
- **ガードレール (PII Shield)** を上流到達前に適用。機密処理では `fail_open: false` にし、検証できないなら通さない
- **自動フェイルオーバー**は C1/C2 で活用、C3 では意図的に無効化（転送先が予測できなくなることを避ける）
- リクエスト単位のコスト情報をコスト統制の土台に利用

ゲートウェイ固有機能は BFF 内に局所化し、アプリからは OpenAI 互換インターフェースのみを見る。差し替えの退避経路を残すため ([ADR-0011](docs/adr/0011-degradation-and-resilience.md))。

## ドキュメント

設計判断の経緯は [docs/adr/](docs/adr/) に記録している。

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

ADR-0002・0003・0004 は相互に依存しているため一体で読むこと。
未公開データの扱いについては ADR-0003・0007・0008・0010 も一体で読むこと。
詳細は [docs/adr/README.md](docs/adr/README.md)。

## 未決事項

- Zotero 連携の方式 (ローカル API か Web API)
- ローカル LLM による C3 (機密データ) 処理 — ADR-0010 で将来の選択肢として余地を残した
- 論文ソースアダプタの実装優先順位
- 分野別プリセットの内容 (論文ソースと埋め込みモデルの組み合わせ)
- Cron の実行時刻、D1 のレポート保持期間

論文ソースと埋め込みモデルは ADR-0009 / ADR-0012 でアダプタ化・設定駆動にしたため、
**研究分野の確定を待つ必要はなくなった。**
