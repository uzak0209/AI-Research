# @ai-research/cli

GUI（`desktop/`）と同じローカルストアを操作する第二の操作面（成功条件 8 / FR-11 /
[ADR-0003](../../docs/adr/0003-references-and-manuscript-factcheck.md)）。Electron 未起動でも動く（NFR-02）。

初版は ADR-0003 の決定どおり **追加・検索・一覧** だけ。書き出し（`.bib` / Hayagriva）は未決。

## セットアップ

`@ai-research/core` は TypeScript ソースを bundler（vite）前提で export しているため、
バンドラを持たないこの CLI 向けには `dist/`（`tsc` の出力）を使う。先に core を build する。

```sh
cd ../core && npm install && npm run build
cd ../cli && npm install
```

## 使い方

```sh
node bin/ai-research.mjs project list
node bin/ai-research.mjs lib add --title "Attention Is All You Need" --authors Vaswani --year 2017
node bin/ai-research.mjs lib search attention
node bin/ai-research.mjs lib list --json
```

`--db <path>` で DB ファイルを明示できる。既定は GUI（desktop）と同じ場所を推定するが、
Electron の userData パスは実行環境依存で確実には特定できないため、
食い違うようなら `--db`（または環境変数 `AI_RESEARCH_DB_PATH`）で明示すること。

## テスト

```sh
npm test
```
