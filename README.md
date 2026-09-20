# AI-Research

研究トレンドの自動追跡。日次収集・重複／活用・テーマ候補・**アプリ内参考文献（GUI＋CLI）**・原稿ファクトチェック。
外部 LLM の統制利用も目的に含む。特定の参考文献マネージャへの依存は前提にしない。

> **設計フェーズ。** 正本は [要件 1 本](docs/requirements.md) と [ADR 3 本](docs/adr/)。

| | |
|---|---|
| [docs/requirements.md](docs/requirements.md) | 何を・なぜ |
| [docs/adr/](docs/adr/) | どう作るか（0001〜0003） |
| [docs/er-diagram.md](docs/er-diagram.md) | データ配置（ER 図） |

## アーキ

- [ADR-0001](docs/adr/0001-runtime-local-data-extensibility.md) — 二層・CLI 共有コア・RAG・データ配置・アダプタ・障害
- [ADR-0002](docs/adr/0002-external-llm-bff-classification.md) — OrcaRouter・BFF・C1/C2/C3
- [ADR-0003](docs/adr/0003-references-and-manuscript-factcheck.md) — 参考文献ライブラリ・CLI・原稿 FC

```
論文ソース → Workers cron → D1 → Electron（RAG / テーマ / ライブラリ UI / FC）
                    共有ローカルストア ↗︎  CLI（ライブラリ等）
                              └→ BFF → OrcaRouter → 上流
```
