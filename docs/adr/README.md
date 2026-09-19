# アーキテクチャ決定記録 (ADR)

本プロジェクトのアーキテクチャ上の決定を記録する。形式は Michael Nygard 形式。

## 一覧

| # | タイトル | ステータス |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | アーキテクチャ決定を ADR として記録する | 承認済み |
| [0002](0002-cloud-cron-plus-desktop-client-split.md) | 定期実行はクラウド、対話処理はデスクトップに分離する | 承認済み |
| [0003](0003-local-only-rag-with-local-embeddings.md) | RAG はローカル完結とし、埋め込みもローカルで推論する | 承認済み |
| [0004](0004-two-stage-relevance-filter.md) | 関連度判定を二段フィルタにする | 承認済み |
| [0005](0005-electron-typescript-single-language-stack.md) | Electron + TypeScript で統一し、Python を必須依存にしない | 承認済み |
| [0006](0006-separate-vector-spaces-per-embedding-model.md) | 埋め込みモデルごとにベクトル空間を分離する | 承認済み |

## 決定の相互関係

ADR-0002（定期実行をクラウドへ）と ADR-0003（RAG をローカルへ）は直接の緊張関係にあり、ADR-0004 がその解決策である。この3つは一体として読むこと。

```
ADR-0002 クラウド cron ──┐
                          ├─→ 矛盾 ─→ ADR-0004 二段フィルタで解決
ADR-0003 ローカル RAG ───┘

ADR-0003 ローカル埋め込み ─→ ADR-0005 Node で実現可能 ─→ ADR-0006 空間分離
```

## 貫かれている原則

**未公開の研究データはローカルに留める。** 実験データ、実験ノート、投稿前の原稿はネットワークに出さない。クラウドに置くのは自分で書いた公開可能な研究概要、キーワード、論文識別子のみ（ADR-0003, ADR-0004）。

## 未決事項

以下は要件として挙がっているが、まだ ADR として決定していない。

- **論文ソースの選定** — arXiv / Semantic Scholar / OpenAlex / Crossref / PubMed のどれを使うか。研究分野に依存する。ADR-0006 は Semantic Scholar の利用を前提にしている
- **原稿のファクトチェック機能の入力方式** — ローカルの `.tex` / `.md` 監視か、Overleaf git bridge 連携か、手動アップロードか
- **Zotero 連携の方式** — ローカル API (7000番ポート) か Web API か
- **埋め込みモデルの最終選定** — `multilingual-e5-large` と `bge-m3` のどちらか。実データでの評価が必要
- **Cron の実行時刻**、D1 のレポート保持期間

## 新しい ADR を追加する

1. 連番の次の番号を使い、`NNNN-kebab-case-title.md` で作成する
2. コンテキスト / 決定 / 検討した代替案 / 帰結 を書く
3. この README の一覧に追記する
4. 既存の決定を覆す場合は、旧 ADR を書き換えず、ステータスを `置き換え済み (ADR-XXXX による)` に変更する
