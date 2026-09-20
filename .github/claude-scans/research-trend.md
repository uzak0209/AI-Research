# 前提検証スキャン（外部依存）

`.github/claude-scans/shared.md` を先に Read。**`proposal` のみ。`auto-scan` 禁止。**

有効 ADR: 0001 / 0002 / 0003。WebSearch / WebFetch で一次情報を確認。推測で issue を作らない。

## 対象

1. **ADR-0001**: Transformers.js / e5・bge-m3、LanceDB Node、Workers/D1/Cron の制約、ソース配布埋め込み（例: S2 specter2）の継続
2. **ADR-0002**: OrcaRouter のゼロ保持範囲・スコープ付きキー・Routing DSL・`fail_open`・価格。上流の保持ポリシー（OpenAI/Anthropic 等）
3. **ADR-0003**: ローカル参考文献ストア、`remark-parse` / `@unified-latex` / `@typstmate/typst-syntax` の供給

## issue

前提崩壊または明確な優位代替のみ。`proposal,upstream`。出典 URL 必須。
