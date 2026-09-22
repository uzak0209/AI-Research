# AI-Research

研究トレンドの自動追跡。**課題意識に近い候補の日次収集**・**候補論文とのローカル類似順位**・
テーマ候補・**アプリ内参考文献（GUI＋CLI）**・
**`.bib` / Typst への自動書き出し**・原稿ファクトチェック。
外部 LLM の統制利用も目的に含む。特定の参考文献マネージャへの依存は前提にしない。

> **設計フェーズ。** 正本は [要件 1 本](docs/requirements.md) と [ADR 5 本](docs/adr/)。
> 実装は [desktop](desktop/)・[worker](worker/)・[packages/core](packages/core/) に部分的にある。
> 未実装の項目は各 README の表を参照。[prototypes/judge-bench](prototypes/judge-bench/) は検証用の関連度ランキング。

| | |
|---|---|
| [docs/requirements.md](docs/requirements.md) | 何を・なぜ（関連の二軸） |
| [docs/adr/](docs/adr/) | どう作るか（0001〜0005） |
| [docs/er-diagram.md](docs/er-diagram.md) | データ配置（ER 図） |

## 何ができるか（初版の目標）

1. アプリ未起動でも、課題意識が近い候補が日次で溜まる（Queue。時間をかけてよい）
2. 起動すると候補が同期され、**課題意識・関連技術との類似度で順位づけ**された一覧が読める（初版は有効／除外を断定しない）
3. 上から読んで本当に関連なら**ワンクリックで参考文献へ**。OA PDF は保存後に取得し、原稿から `\cite{}` できる状態まで届く
4. 執筆中原稿の主張を検査できる
5. 外部 LLM を統制下で呼べる（利用自体が目的）
6. 新着から次のテーマ候補を提示できる
7. GUI と同じローカルデータに CLI から触れられる

## アーキ

- [ADR-0001](docs/adr/0001-runtime-local-data-extensibility.md) — 二層・**ローカル関連度採点**・CLI 共有コア・RAG・データ配置・障害
- [ADR-0002](docs/adr/0002-external-llm-bff-classification.md) — OrcaRouter・BFF・C1/C2/C3
- [ADR-0003](docs/adr/0003-references-and-manuscript-factcheck.md) — 参考文献ライブラリ・**PDF／注釈**・CLI・原稿 FC
- [ADR-0004](docs/adr/0004-cloudflare-edge-and-scheduling.md) — クラウド全体構成（無料枠・収集・BFF・防御）
- [ADR-0005](docs/adr/0005-cloud-trend-survey-model-tiering.md) — クラウド側トレンド調査・競合収集の 2 段パイプライン（収集／レビュー）・Named Router によるモデル使い分け

```
論文ソース → Workers cron → D1 → Electron（関連度採点 / ライブラリ UI+PDF / RAG / テーマ / FC）
                    共有ローカルストア ↗︎  CLI（ライブラリ等）
                              └→ BFF → OrcaRouter → 上流（テーマ・FC のみ）

cron → Queues 収集 → OrcaRouter(rs-collect) → 論文ソース → D1
              D1 → Queues レビュー → OrcaRouter(rs-review) → D1（competing/usable・reason・evidence）
```

## 原則

- **関連度の採点はローカル推論で完結する**（`C-09`）。採点のために論文・原稿を外部へ出さない。
  外部 LLM が担うのはテーマ候補とファクトチェック
- **引けない線は引かない**（`C-07`）。実データで有効／除外の閾値が分離できなかったため、
  初版は**順位だけ**を出して断定しない
- **未公開データの恒久的な外部インデックスを作らない**（`C-01`）。
  埋め込みはローカル推論のみで、埋め込み API は使わない
- **外部 LLM は分類統制下でのみ使う**（`C-04`）。埋め込み（全件・恒久）と
  プロンプト（都度・必要範囲）はリスクの性質が違うため扱いを分ける。
  機密（C3）はモデル固定・フォールバック無効・同意必須で、機能ごと完全オフ可
- **開発者の有料 API キーをクライアントに置かない**（`C-06`）。BFF を挟む
- **ユーザーのファイルを壊さない**（`C-08`）。引用ファイルへの書き出しは
  マーカー内のみを再生成し、マーカー外は読むだけ。消されていたら何もしない
- **欠損を成功と偽らない**（`C-07`）。「0 件」と「取得失敗」を区別する

> ゲートウェイのゼロデータ保持は**ゲートウェイ自社サーバのみ**が対象で、
> 上流プロバイダは各自の保持ポリシーに従う。「残らない」とは説明しない。


## ローカル検証

入口は `just`（未導入なら `brew install just`）。`just` で一覧が出る。

```bash
just env                 # worker/.dev.vars と local D1
just worker              # BFF  http://127.0.0.1:8787
just desktop             # Electron。API は prod（https://ai-research.streeeak.link）
just seed-desktop        # Electron を機能紹介用のデモで埋める
just seed-staging        # staging D1（dev）を同じ物語で埋める
just verify              # worker 起動中に /health と書誌 BFF
```

有料キーは `worker/.dev.vars` に書く。GitHub Secret からは引き戻せない。クライアントには置かない（`C-06`）。
デスクトップの書誌補完と Google ログインは Worker の BFF 経由。OAuth の callback は `http://127.0.0.1`。
