# アーキテクチャ決定記録 (ADR)

有効は **4 本**。要件は [docs/requirements.md](../requirements.md) 1 本。

| # | 内容 | 成功条件 |
|---|---|---|
| [0001](0001-runtime-local-data-extensibility.md) | 二層・CLI 共有コア・RAG・データ配置・アダプタ・障害 | 1, 2, 6, 7 |
| [0002](0002-external-llm-bff-classification.md) | LLM・BFF・C1/C2/C3 | 5 |
| [0003](0003-references-and-manuscript-factcheck.md) | 参考文献ライブラリ・CLI・原稿 FC | 3, 4, 7 |
| [0004](0004-cloudflare-edge-and-scheduling.md) | クラウド全体構成（無料枠・収集・BFF・防御） | 1, 5 |

決定だけ短く書く。5 本目を増やす前に既存 4 本に入るか検討する。無効ファイルは残さない。
