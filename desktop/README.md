# desktop

[ADR-0001](../docs/adr/0001-runtime-local-data-extensibility.md) のデスクトップ側。
Electron + TypeScript、ローカル SQLite、Transformers.js による関連度採点。

## 今できること

| | 状態 |
|---|---|
| ローカル SQLite（16 表）の作成と読み書き | 動く |
| sqlite-vec によるベクトル保持と KNN | 動く |
| 概要・自分の主張の編集 | 動く |
| 関連度採点（`utilityProcess`、中断・再開つき） | 動く |
| 関連度順の一覧と「近い自分の主張」の併記 | 動く |
| クラウドからの同期 | **未実装**（Worker 側 `/runs` が 501） |
| PDF 閲覧・注釈（FR-14） | **未実装**（表だけある） |
| 引用ファイル書き出し（FR-12） | **未実装** |
| CLI（FR-11） | **未実装**（`src/shared/` を共有する形で足す） |

## 動かす

```bash
npm install --legacy-peer-deps   # npm 10.9 の peer 解決バグ回避
npm run dev                       # 開発（HMR）
npm run build && npx electron out/main/index.js   # ビルドして起動
npm test                          # 27 件
npm run typecheck
```

## 構成

```
src/shared/   GUI と CLI が共有するコア（FR-11。二重管理しない）
  db.ts       node:sqlite で開く／sqlite-vec を読む
  schema.sql  ローカルスキーマ（?raw でバンドルに取り込む）
  repo.ts     問い合わせ。有効／除外の列を持たない
  scorer.ts   blend 採点。埋め込みは差し替え可能（テスト用）
src/main/     メインプロセスと採点ワーカー
src/preload/  contextBridge の窓口
src/renderer/ UI（素の TS。フレームワーク無し）
```

## 実測で決めたこと

### SQLite は `node:sqlite`（ネイティブ npm 依存ゼロ）

Electron 44 は Node 24.21 を積んでおり、`node:sqlite` に `enableLoadExtension` がある。
**better-sqlite3 を入れない。** OS ごとの prebuild もリビルドも要らない（`NFR-05`）。

### sqlite-vec は Electron で読める

ER 図で未決だった点。実機で `vec_version()` = v0.1.9、KNN も正しく動いた。
読めない環境では**黙って縮退せず**起動時に落とす（`C-07`）。

### 採点は `utilityProcess`

1 件 80 ms のため、レンダラでもメインでも回さない（`NFR-06`）。
**1 件ごとに DB へ確定**するので、途中で閉じても済んだ分は残り、
残りは `scored_at IS NULL` で拾って再開する（採点キュー表は作らない）。

## スキーマが ER 図と違う点

実際に動かして判明した制約による。

| ER 図 | 実装 | 理由 |
|---|---|---|
| `references` | `reference_items` | `references` は SQLite の予約語で CREATE TABLE できない |
| `nearest_claim_id`（text） | `nearest_chunk_id`（integer） | 主張は `chunks` なので型と参照先を合わせた |

## 表示の原則（C-07）

- **有効／除外を断定しない。** 順位だけを出す
- **未採点は「未採点 n 件」と実数で出す。** 推定や「およそ」を書かない
- **未採点を一覧に混ぜない。** 混ぜると採点漏れに気づけない
- **採点前の順位を先出ししない**（楽観的 UI を採らない）
- 概要や主張を変えたら採点済みの印を落とす。古い順位を見せ続けない

## つまずいた点（同じ踏み方をしないため）

- **`electron` は devDependency なので `externalizeDepsPlugin` の対象外。**
  明示的に external に入れないと npm パッケージ側（バイナリのパスを返すだけ）が
  同梱され、`Electron failed to install correctly` で落ちる
- **Windows の GUI プロセスは stdout が端末に出ない。**
  起動時の失敗は `userData/startup.log` に残している
- `schema.sql` はバンドルに含まれないので `?raw` で文字列として取り込む

## 未対応

- クラウド同期、PDF 閲覧・注釈、引用ファイル書き出し、CLI
- 配布（electron-builder 等）と署名
- 日本語の要旨・プロフィールでの採点精度（未計測）
