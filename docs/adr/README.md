# アーキテクチャ決定記録 (ADR)

有効は **5 本**。要件は [docs/requirements.md](../requirements.md) 1 本。

| # | 内容 | 成功条件 |
|---|---|---|
| [0001](0001-runtime-local-data-extensibility.md) | 二層・起動時プル→ローカル関連度採点・CLI・RAG・データ配置 | 1, 2, 7, 8 |
| [0002](0002-external-llm-bff-classification.md) | LLM・BFF・C1/C2/C3 | 6 |
| [0003](0003-references-and-manuscript-factcheck.md) | 参考文献ライブラリ・CLI・原稿 FC | 4, 5, 8 |
| [0004](0004-cloudflare-edge-and-scheduling.md) | クラウド全体構成（無料枠・収集・BFF・防御）（提案） | 1, 3, 6 |
| [0005](0005-cloud-trend-survey-model-tiering.md) | クラウド側トレンド調査・Named Router | 1, 3, 6 |

決定だけ短く書く。6 本目を増やす前に既存に入るか検討する。無効ファイルは残さない。
