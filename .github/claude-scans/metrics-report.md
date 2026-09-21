# 指標レポート（PR merge / 定時）

`.github/claude-scans/shared.md` を先に Read。

**あなたの仕事は文章だけ。**数値とグラフは CI が既に出している。
グラフを描き直さない。数値を推測・水増ししない（`C-07`）。

## 入力（この順で Read）

1. `metrics/pr-context.json` — 今回のきっかけ（merge した PR、または schedule / 手動）
2. `metrics/metrics.json` — 決定的な集計。主指標は **トークン/論文** と **点数（coarse_score 平均）**
3. `metrics/charts.md` — 同じ JSON から作った Mermaid。**触らない**（後段がそのまま docs に載せる）

## 書くもの

`metrics/narrative.md` にだけ Write する。他のファイルは変えない。コミットもしない。

構成:

```markdown
## 今回なにをしたか

（PR のタイトル・要点。schedule / 手動なら「定時の再計測」などと書く）

## 指標はどう動いたか

（metrics.json の trend / totals だけを根拠に、トークン/論文と点数を短く）
（取得本数も必ず触れる。本数減だけの「改善」は改善と呼ばない）
（母数不足・データなしなら、その旨を書いて打ち切る。無い改善を書かない）

## いま言えること / 言えないこと

（1〜3 行。推測は「仮説」と明示）
```

## 禁則

- `metrics.json` に無い数値を書かない
- `summary`・要旨・検索語・秘密を書かない
- Named Router のコンソール操作や、コード変更の実行はしない
- charts.md を編集・再生成しない
- issue / PR を作らない

最後に「narrative.md を書いた」とだけ出力する。
