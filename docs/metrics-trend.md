# 指標レポート

トークン/見つけた論文と点数（`coarse_score` 平均）の推移。
**数値と SVG グラフは決定的スクリプト**、**文章のまとめは Claude**（ADR-0005 §10）。

> まだ自動更新されていない。`dev` / `main` への merge、または
> Actions の **Metrics trend** を手動実行すると、このファイルと下の SVG が書き換わる。
> 改善フロー（proposal issue）は約 30 分ごとに回る。母数が足りなければ出さない。

## グラフ

![トークン/論文](metrics-tokens.svg)

![点数 (coarse_score 平均)](metrics-score.svg)

![取得論文数](metrics-papers.svg)

## 見方

| 指標 | 良い方向 |
|---|---|
| トークン / 論文 | 下がる |
| 点数（coarse_score 平均） | 上がる |
| 取得論文数 | 比率と必ず併記。本数だけ減らして比率を良くしても改善ではない |

手動で同じものを見る:

```bash
node scripts/retro-metrics.mjs --env dev --days 14 > metrics.json
node scripts/render-charts-svg.mjs metrics.json docs
node scripts/render-trend.mjs metrics.json
```
