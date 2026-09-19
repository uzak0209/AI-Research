# 前提検証スキャン（外部依存の動向）

`.github/claude-scans/shared.md` を先に Read して従え。

ADR が**前提にしている外部の事実**が、まだ正しいかだけを検証する。
このリポジトリ内部の設計の穴は design-review、書式は adr-hygiene の担当。

このスキャンは `proposal` のみを作る。**`auto-scan` は絶対に付けない。**
外部動向を根拠に自動で設計を書き換えさせてはいけない。

## 背景

ADR には、検証時点では正しかったが将来変わりうる前提がいくつもある。
それが崩れたときに静かに劣化するのを防ぐのがこのスキャンの目的。

## 調べる対象

ADR を Read して前提を特定し、WebSearch / WebFetch で現状を確認する。
確認できなかったものは「確認できなかった」として扱い、推測で issue を作らない。

1. **ADR-0006 の前提: Semantic Scholar API が specter2 ベクトルを無料提供している**
   - これが最も重要な前提。崩れると ADR-0006 の構成が成立しない
   - API の提供終了、有料化、レート制限の大幅な変更が無いか
   - `specter2` の後継モデルが出ていないか

2. **ADR-0006 の前提: specter2 に ONNX 版が公開されていない**
   - 公開されていれば選択肢が広がるので報告する価値がある

3. **ADR-0003 / ADR-0005 の前提: 埋め込みモデルの選択肢**
   - `Xenova/multilingual-e5-large` と `Xenova/bge-m3` が引き続き利用可能か
   - 学術用途で明確に優位な新しい多言語埋め込みモデルが出ていないか
   - Transformers.js の WebGPU 対応状況に大きな変化が無いか

4. **ADR-0002 の前提: Cloudflare Workers / D1 / Cron Triggers の制約**
   - D1 の容量・行数制限、Workers の CPU 時間制限が、
     日次の論文収集という用途に対して問題になる変更が無いか
   - Cron Triggers の仕様変更

5. **ADR-0005 の前提: LanceDB の Node バインディング**
   - `@lancedb/lancedb` が維持されているか

6. **ADR-0007 / ADR-0010 の前提: OrcaRouter の仕様**（優先度高）
   - ゼロデータ保持の適用範囲が**自社サーバのみ**という記述が変わっていないか。
     ADR-0010 の C3 統制はこの事実に基づいて設計されている
   - スコープ付きキー（個別の予算・上限・失効）が引き続き提供されているか
   - Routing DSL の `model` / `models` / `pool` による固定が可能なままか
   - チャネル固定（`channels:` / `@channel:`）が提供開始されていないか
     （されたら C3 の統制を強化できる）
   - ガードレールの fail-open 既定と `fail_open: false` の指定が可能なままか
   - トークンマークアップ 0 の価格方針が変わっていないか
   - 出典は必ず <https://docs.orcarouter.ai/> の一次情報を使う

7. **ADR-0013 の前提: 原稿パーサの供給状況**
   - `@typstmate/typst-syntax` は Obsidian プラグインのサブパッケージであり、
     独立保守されていない。更新停止・削除・Typst 本体への追従遅れが無いか
   - Typst の独立した TS/JS パーサが新たに公開されていないか（あれば乗り換え候補）
   - `@unified-latex/*` と `remark-parse` が維持されているか

8. **ADR-0010 の前提: 上流プロバイダの保持ポリシー**
   - OpenAI / Anthropic の不正利用ログ保持期間（約 30 日）に変更が無いか
   - 学習利用に関する規約変更が無いか
   - ゼロ保持契約（ZDR）を提供するプロバイダが増えていないか

## issue の作り方

前提が崩れている、または明確に優位な代替が出ている場合のみ:

```
gh issue create --label proposal,upstream --title "..." --body "..."
```

- ラベルが無ければ作る:
  - `gh label create proposal --color FBCA04 --description "Proposal (no auto-implementation)"`
  - `gh label create upstream --color C5DEF5 --description "External dependency change"`
- 本文に必ず含める:
  - 影響を受ける ADR 番号
  - 元の前提（ADR の該当箇所を引用）
  - 現状（出典 URL を明記。一次情報を優先する）
  - 前提が崩れた場合に何を再検討すべきか
- 1 回の上限 2 件
- **`auto-scan` は付けない。** 人間が読んで判断する

## 出さないもの

- 「新しいモデルが出た」だけで、既存の選択より優位と言えないもの
- ベンチマーク上のわずかな差
- 出典が示せないもの、ブログの二次情報のみのもの
- 一般的な技術トレンドの紹介
