# リポジトリ規約

AI エージェント（および人間）がこのリポジトリで作業する際の規約。

## このリポジトリの状態

**設計フェーズ。実装コードはまだ無い。** 中身は以下のみ。

- `docs/adr/` — アーキテクチャ決定記録
- `README.md` — 概要
- `.github/` — 自動化ワークフロー

「実装が無い」ことは問題ではない。実装を勝手に始めないこと。

## ブランチ運用

- `main` — 安定版。直接 push しない
- `dev` — 開発の基点。feature ブランチはここから切り、PR もここへ向ける
- `main` への PR は `dev` からのみ。それ以外は `pr-target.yml` が自動クローズする

## ADR の扱い

**最も重要な規約。**

- 設計上の判断は `docs/adr/` に ADR として記録する
- **記録済みの決定に反する変更をしてはいけない。** 決定を覆すべきだと考えた場合は、
  実装や文書を勝手に変えず、新しい ADR を追加する提案として出す
- 既存 ADR を書き換えて決定を覆さない。新しい ADR を起こし、
  旧 ADR のステータスを `置き換え済み (ADR-XXXX による)` に変更する
- ADR を追加したら `docs/adr/README.md` の一覧とルート `README.md` の表にも追記する
- 形式は Michael Nygard 形式。コンテキスト / 決定 / 検討した代替案 / 帰結 を書く
- ファイル名は `NNNN-kebab-case-title.md`

### 破ってはいけない設計原則

**未公開の研究データはローカルに留める**（ADR-0003, ADR-0004）。

実験データ、実験ノート、投稿前の原稿をクラウドに送信する設計にしない。
埋め込み生成もローカルモデルで行い、埋め込み API は使わない。
クラウドに置くのは、公開可能な研究概要・キーワード・論文識別子のみ。

## public リポジトリであることへの注意

このリポジトリは **public** である。

- 研究テーマの詳細、未公開のアイデア、実験結果を issue / PR / コミットメッセージに書かない
- 未公開データを誤ってコミットしない。`.gitignore` で `data/`、`manuscripts/`、
  `notes/`、`papers-pdf/`、`*.lance/` 等を除外している
- 新しくデータ置き場を作る場合は、**ファイルを置く前に** `.gitignore` に追加する
- 一度 push したものはクローンやキャッシュから消せない

## 自動化

- `claude.yml` — issue が open されると自動着手し、`dev` 向けに PR を出す。
  コメントで `@claude` と書いても反応する
- `claude-scan.yml` — 1 日 1 回（JST 06:00）スキャンを走らせ、issue を作る。
  `auto-scan` ラベルが付いた issue は `claude.yml` が拾って自動で PR を出す。
  `proposal` ラベルは人間が判断する（自動実装しない）
- スキャンの指示は `.github/claude-scans/` にある。挙動を変えたい場合はそこを編集する

### 必要な設定

- リポジトリシークレット `CLAUDE_CODE_OAUTH_TOKEN`
  （`claude setup-token` で発行し、Settings → Secrets and variables → Actions に登録）
- Settings → Actions → General → Workflow permissions で
  「Read and write permissions」と「Allow GitHub Actions to create and approve pull requests」を有効化

## コミットメッセージ

- 1 行目は `<type>: <要約>`（`docs:`, `feat:`, `fix:`, `chore:`, `ci:`）
- 本文には「なぜ」を書く。「何を」は diff を見れば分かる
