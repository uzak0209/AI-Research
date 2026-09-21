# 前提検証スキャン（外部依存）

`.github/claude-scans/shared.md` を先に Read。**`proposal` のみ。`auto-scan` 禁止。**

有効 ADR: 0001 / 0002 / 0003 / 0004 / 0005。WebSearch / WebFetch は補助。
**断定は実測。** 環境の `ORCAROUTER_API_KEY` / `JEV_API_KEY` / `OPENALEX_API_KEY` で最小の生リクエストを打ち、HTTP status・応答のモデル名／価格フィールドを根拠にする。キー値は issue に出さない。キーが空なら実測不能と書いて終わる。

## 対象

1. **ADR-0001**: Transformers.js / e5・bge-m3、LanceDB Node、Workers/D1/Cron の制約、ソース配布埋め込み（例: S2 specter2）の継続
2. **ADR-0002**: OrcaRouter のゼロ保持範囲・スコープ付きキー・Routing DSL・`fail_open`・価格。上流の保持ポリシー（OpenAI/Anthropic 等）。**価格とルーティングはドキュメントではなく実測**
3. **ADR-0003**: ローカル参考文献ストア、`remark-parse` / `@unified-latex` / `@typstmate/typst-syntax` の供給
4. **Jev（TypeSafe System One）**: `POST https://api.typesafe.ai/v1/systemone` が鍵で通るか。noul/choice が型どおり返るか

## issue

前提崩壊または明確な優位代替のみ。`proposal,upstream`。出典は **実測の要約（status・モデル・数値）** と公式 URL。推測で作らない。
