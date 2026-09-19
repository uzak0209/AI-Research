# ADR-0015: Zotero 接続に OAuth 1.0a を採り、Client Secret は BFF に置く

- **ステータス**: 承認済み
- **日付**: 2026-09-19
- **関連**: ADR-0014（ローカル API 主・Web API 副は維持。OAuth 非採用の節を本 ADR が置き換え）

## コンテキスト

ゴール成功条件 3 / `FR-05`。Zotero 前提の利用者に、ブラウザ許可での接続を提供する。
ADR-0014 の「OAuth 初期対象外」を改め、Client Secret は BFF（`C-06` と同型の置き場）に置く。

## 決定

### 1. ADR-0014 の経路方針は維持する

- **主**: ローカル API (`127.0.0.1:23119`) — Zotero デスクトップ起動時
- **副**: Web API — デスクトップ未起動時やクラウドライブラリ直書きが必要なとき

### 2. Web API 用の資格情報は OAuth 1.0a で取得する（手動キーは退避）

- 初回接続はアプリ内の「Zotero を接続」から開始する
- 取得した長期 API キーと `userID` は **OS の secure storage** に保存する
- 手動キーの貼り付けは、OAuth が使えない環境向けの退避として残す

### 3. Client Key / Secret は BFF（Workers Secrets）にのみ置く

```
Electron                    BFF                         zotero.org
   │  接続開始                │
   │─────────────────────────→│  request token（Secret 使用）
   │←─────────────────────────│  authorize URL + 一時状態
   │  ブラウザで許可           │
   │  localhost コールバック   │
   │─────────────────────────→│  verifier を渡す
   │                          │─────────────────────────→ access exchange
   │←─────────────────────────│  userID + API キー（一度きり）
   │  Keychain に保存          │  BFF はキーを恒久保存しない
```

- 以降の論文保存は **BFF を通さない**（ADR-0014 と同じ。書誌情報を自サーバに溜めない）
- ローカル API が使えるときはそちらを優先する
- BFF は OAuth ハンドシェイク専用。LLM エンドポイントと相乗りさせない

### 4. ADR-0014 「OAuth は採らない」を置き換え

ADR-0014 の決定 §3 は本 ADR により無効とする。
経路の主／副（§1・§2）とデータ分類の節は有効のまま。

## 検討した代替案

**Electron に Client Secret を同梱** — 実装は短い。なりすましリスクは残る。
BFF が既にあるため採用しない。

**手動キーのみ** — ADR-0014 のまま。摩擦が大きく、Zotero 前提の UX に合わない。却下。

**保存トラフィックも BFF 経由** — Secret 管理は楽だが、書誌保存が SaaS 面になる。却下。

## 帰結

**良い点**

- 接続 UX が「設定画面でキー発行」から「ブラウザで許可」に変わる
- Client Secret が配布物に出ない
- 保存経路は ADR-0014 のままローカル優先を維持できる

**悪い点**

- OAuth 1.0a とコールバック用の BFF エンドポイントが増える
- BFF 不通時は新規接続できない（既存キーでの保存・ローカル API は可）
- 「ワンクリック」ではない（ログイン状態によっては複数画面）

## 参考

- [FR-05](../requirements/01-functional.md)
- ADR-0008: BFF / Workers Secrets
- ADR-0014: ローカル API 主・Web API 副
- `prototypes/zotero-oauth/`
- <https://www.zotero.org/support/dev/web_api/v3/oauth>
