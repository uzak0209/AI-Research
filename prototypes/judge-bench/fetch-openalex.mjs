// 実在の要旨を OpenAlex から取得して fixtures を作る。
// 合成データでの計測が良く出すぎている疑いを潰すのが目的なので、
// 「明確に関連 / 境界 / 明確に無関係」の 3 層を意図的に混ぜる。
//
//   node fetch-openalex.mjs --out=fixtures/papers-real.json
//
// arXiv API は IP 単位で 429 を返したため OpenAlex を使う（2026-09-20 時点）。
// polite pool の mailto は付けない（利用者のメールアドレスを無関係なサービスに出さない）。

import { writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const OUT = args.out ?? 'fixtures/papers-real.json';

// tier: A=明確に関連 / B=境界（ここが本番） / C=明確に無関係
const QUERIES = [
  { tier: 'A', n: 8, s: 'molecular property prediction graph neural network' },
  { tier: 'A', n: 6, s: 'molecular property prediction transfer learning pretraining' },

  // 手法は近いが対象が違う / 対象は近いが手法が違う = 実務で迷う層
  { tier: 'B', n: 5, s: 'graph neural network transfer learning social network' },
  { tier: 'B', n: 5, s: 'uncertainty quantification deep learning image classification' },
  { tier: 'B', n: 5, s: 'large language model drug discovery' },
  { tier: 'B', n: 5, s: 'machine learning interatomic potential molecular dynamics' },
  { tier: 'B', n: 4, s: 'few-shot meta-learning small data regime' },

  { tier: 'C', n: 4, s: 'galaxy morphology classification deep learning survey' },
  { tier: 'C', n: 4, s: 'reinforcement learning robotic manipulation' },
  { tier: 'C', n: 4, s: 'neural machine translation low resource languages' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// OpenAlex の要旨は転置インデックスで入っているので語順を戻す
function rebuildAbstract(ii) {
  if (!ii) return '';
  const slots = [];
  for (const [word, positions] of Object.entries(ii)) {
    for (const p of positions) slots[p] = word;
  }
  return slots.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

const seen = new Set();
const papers = [];
const failures = [];

for (const [i, { tier, n, s }] of QUERIES.entries()) {
  const url =
    'https://api.openalex.org/works?filter=' +
    encodeURIComponent(`title_and_abstract.search:${s},has_abstract:true,from_publication_date:2023-01-01,type:article`) +
    `&per-page=${n + 10}&sort=relevance_score:desc`;

  process.stdout.write(`[${i + 1}/${QUERIES.length}] tier=${tier} ${s}\n`);
  let data;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'judge-bench/0.1 (design-phase prototype)' } });
    if (!res.ok) throw new Error(`status=${res.status}`);
    data = await res.json();
  } catch (e) {
    // FR-08 / C-07 と同じ扱い。取得失敗は 0 件として黙らせない
    console.error(`  取得失敗: ${e.message}`);
    failures.push({ tier, s, error: String(e.message) });
    await sleep(1500);
    continue;
  }

  let taken = 0;
  for (const w of data.results ?? []) {
    if (taken >= n) break;
    const abstract = rebuildAbstract(w.abstract_inverted_index);
    if (abstract.length < 500 || abstract.length > 2500) continue; // 代表性のため極端な長さを外す
    const title = (w.display_name ?? '').trim();
    if (!title) continue;
    const key = w.doi ?? w.id;
    if (seen.has(key)) continue;
    seen.add(key);
    papers.push({
      id: `r${String(papers.length + 1).padStart(2, '0')}`,
      tier,
      title,
      abstract,
      year: w.publication_year,
      doi: w.doi ?? null,
      openalex_id: w.id,
    });
    taken++;
  }
  console.log(`  -> ${taken} 件（候補 ${(data.results ?? []).length}）`);
  await sleep(1500);
}

const doc = {
  _note:
    '実在の論文（OpenAlex 由来・公開書誌のみ）。tier は取得クエリ由来の区分で、' +
    'A=明確に関連 / B=境界 / C=明確に無関係。expected は未設定。label-real.mjs で付けてから計測する。',
  _fetched_at: new Date().toISOString(),
  _source: 'OpenAlex API',
  _failures: failures, // 「0 件」と「取得失敗」を混ぜない（FR-08）
  summary:
    'We develop graph neural networks for molecular property prediction, focusing on the low-data regime. Our main interest is transfer learning and pretraining strategies that let a model trained on large public molecule corpora adapt to small proprietary assay datasets (hundreds of labeled molecules), together with calibrated uncertainty estimates so that chemists know when to distrust a prediction.',
  papers,
};

writeFileSync(OUT, JSON.stringify(doc, null, 2), 'utf8');
const byTier = papers.reduce((a, p) => ((a[p.tier] = (a[p.tier] ?? 0) + 1), a), {});
const L = papers.map((p) => p.abstract.length);
console.log(`\n合計 ${papers.length} 件 ${JSON.stringify(byTier)}`);
if (failures.length) console.log(`取得失敗 ${failures.length} クエリ（0 件ではない）`);
console.log(`要旨の長さ min/avg/max: ${Math.min(...L)} / ${Math.round(L.reduce((a, b) => a + b, 0) / L.length)} / ${Math.max(...L)}`);
console.log(`wrote ${OUT}`);
