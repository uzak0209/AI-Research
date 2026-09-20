# judge-bench

**検証用。本番ではない**（`AGENTS.md`）。

[ADR-0001](../../docs/adr/0001-runtime-local-data-extensibility.md) の
「ローカル推論は Transformers.js（ONNX Runtime）に載せる」という決定の検証と、
その上に載せる**関連度ランキング**の実装。

実測の結論は [FINDINGS.md](FINDINGS.md)。

## 中身

| ファイル | 何をするか |
|---|---|
| `rank.mjs` | **関連度順の提示**（埋め込みのみ・生成 LLM なし）。本命 |
| `embed-bench.mjs` | 2 段目の分離性能を測る |
| `bench.mjs` | 3 段目（生成 LLM）の速度と一致率を測る。**採用は見送り**。記録として残す |
| `fetch-openalex.mjs` | 実在の要旨を取得して fixtures を作る |
| `label-real.mjs` | 取得した論文に人手ラベルを付ける |

## rank.mjs — 関連度順の提示

```bash
npm install
node rank.mjs --top=20
node rank.mjs --papers=fixtures/papers-real.json --profile=fixtures/profile.json --json=results/ranked.json
node rank.mjs --score=summary     # summary | max | blend
```

出すもの:

- **関連度順の一覧**
- 各論文が**自分のどの主張に最も近いか**（`fixtures/profile.json` の `claims`）

後者は最近傍という**事実**であって判定ではない。
「有効／除外」の断定も理由付けもしない（生成 LLM を使わないため。`C-07`）。

### 自分の研究に合わせる

`fixtures/profile.json` を差し替える。

- `summary`: プロジェクトの狙いを 3〜5 行
- `claims`: 自分が論文で主張する（予定の）ことを 1 つ 1 文で 5〜15 個。未公開でよい

`claims` が空でも動くが、その場合は概要との近さだけになる。

### スコアリング方式

| 方式 | 中身 | 実測（n=50・取りこぼしゼロに必要な件数） |
|---|---|---|
| `blend`（既定） | 概要 0.7 ＋ 最も近い主張 0.3 | **17 / 50（34 %）** |
| `summary` | 概要との近さのみ | 19 / 50（38 %） |
| `max` | 概要と主張の高い方 | 21 / 50（42 %） |

`blend` と `summary` の差は n=50 では誤差の範囲。**明確に劣るのは `max`** で、
主張の文面が手法寄りなため、分野違いの手法論文を引き上げてしまう
（例: 自分の主張「アンサンブルを較正する」に、医用画像の較正論文が食いつく）。

## fixtures

| ファイル | 中身 |
|---|---|
| `papers.json` | **合成データ**。実在の論文ではない。速度計測用 |
| `papers-real.json` | **実在の論文 50 件**（OpenAlex 由来・公開書誌のみ） |
| `profile.json` | **仮のプロフィール**。自分の研究に差し替える |

`papers-real.json` は「明確に関連 14 / 境界 24 / 明確に無関係 12」を意図的に混ぜてある。
境界層があるかどうかで数字が大きく変わるため、合成データの結果は当てにしない。

ラベル（`expected`）は **Claude が要旨を読んで付けたもので、当該分野の研究者の判断ではない**。
境界層には `label_confidence` を併記してある。実運用の判断に使う前に本人が見直すこと。

arXiv API は IP 単位で `Rate exceeded.` を返したため使っていない（2026-09-20 時点）。
OpenAlex の polite pool の `mailto` は付けていない（利用者のメールアドレスを外部に出さないため）。

## 測っていないもの

- 日本語の要旨・日本語のプロフィール
- プロジェクトが 2 つ以上ある場合、埋め込みモデルを替えた場合
- 件数が数千件に増えたときの検索速度（sqlite-vec に載せてから測る）
