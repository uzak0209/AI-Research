// 実在の要旨を arXiv から取得して fixtures を作る。
// 合成データでの計測が良く出すぎている疑いを潰すのが目的なので、
// 「明確に関連 / 境界 / 明確に無関係」の 3 層を意図的に混ぜる。
//
//   node fetch-arxiv.mjs --out=fixtures/papers-arxiv.json
//
// arXiv API は連続アクセスに 3 秒の間隔を求めているので守る。

import { writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const OUT = args.out ?? 'fixtures/papers-arxiv.json';

// tier: A=明確に関連 / B=境界（ここが本番） / C=明確に無関係
const QUERIES = [
  { tier: 'A', n: 10, q: 'abs:"molecular property prediction" AND abs:"graph neural network"' },
  { tier: 'A', n: 4, q: 'abs:"molecular property prediction" AND abs:"transfer learning"' },

  // 手法は近いが対象が違う / 対象は近いが手法が違う = 実務で迷う層
  { tier: 'B', n: 5, q: 'abs:"graph neural network" AND abs:"transfer learning" AND cat:cs.SI' },
  { tier: 'B', n: 5, q: 'abs:"uncertainty quantification" AND abs:"neural network" AND cat:cs.CV' },
  { tier: 'B', n: 5, q: 'abs:"drug discovery" AND abs:"large language model"' },
  { tier: 'B', n: 5, q: 'abs:"molecular dynamics" AND abs:"machine learning" AND abs:"force field"' },
  { tier: 'B', n: 4, q: 'abs:"few-shot learning" AND abs:"meta-learning" AND cat:cs.LG' },

  { tier: 'C', n: 4, q: 'cat:astro-ph.GA AND abs:"deep learning"' },
  { tier: 'C', n: 4, q: 'cat:cs.RO AND abs:"reinforcement learning"' },
  { tier: 'C', n: 4, q: 'cat:cs.CL AND abs:"machine translation"' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/\s+/g, ' ').trim();

function parseFeed(xml) {
  const out = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const pick = (tag) => {
      const r = e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return r ? strip(r[1]) : '';
    };
    const id = pick('id');
    const cats = [...e.matchAll(/<category[^>]*term="([^"]+)"/g)].map((c) => c[1]);
    out.push({
      arxiv_id: id.split('/abs/')[1] ?? id,
      title: strip(pick('title')),
      abstract: strip(pick('summary')),
      published: pick('published').slice(0, 10),
      categories: cats,
    });
  }
  return out;
}

const seen = new Set();
const papers = [];

for (const [i, { tier, n, q }] of QUERIES.entries()) {
  const url =
    'https://export.arxiv.org/api/query?search_query=' +
    encodeURIComponent(q) +
    `&start=0&max_results=${n + 6}&sortBy=submittedDate&sortOrder=descending`;

  process.stdout.write(`[${i + 1}/${QUERIES.length}] tier=${tier} ${q}\n`);
  const res = await fetch(url, { headers: { 'User-Agent': 'judge-bench/0.1 (design-phase prototype)' } });
  if (!res.ok) {
    console.error(`  取得失敗 status=${res.status} -> このクエリは空で続行`);
    await sleep(3000);
    continue;
  }
  const entries = parseFeed(await res.text());

  let taken = 0;
  for (const e of entries) {
    if (taken >= n) break;
    if (!e.abstract || e.abstract.length < 400) continue; // 極端に短い要旨は代表性が落ちるので外す
    if (seen.has(e.arxiv_id)) continue;
    seen.add(e.arxiv_id);
    papers.push({ id: `a${String(papers.length + 1).padStart(2, '0')}`, tier, ...e });
    taken++;
  }
  console.log(`  -> ${taken} 件（候補 ${entries.length}）`);
  await sleep(3000); // arXiv の要請
}

const doc = {
  _note:
    '実在の arXiv 論文。tier は取得クエリ由来の区分（A=明確に関連 / B=境界 / C=明確に無関係）。' +
    'expected はまだ入っていない。label-arxiv で付けてから計測すること。',
  _fetched_at: new Date().toISOString(),
  summary:
    'We develop graph neural networks for molecular property prediction, focusing on the low-data regime. Our main interest is transfer learning and pretraining strategies that let a model trained on large public molecule corpora adapt to small proprietary assay datasets (hundreds of labeled molecules), together with calibrated uncertainty estimates so that chemists know when to distrust a prediction.',
  papers,
};

writeFileSync(OUT, JSON.stringify(doc, null, 2), 'utf8');
const byTier = papers.reduce((a, p) => ((a[p.tier] = (a[p.tier] ?? 0) + 1), a), {});
const L = papers.map((p) => p.abstract.length);
console.log(`\n合計 ${papers.length} 件 ${JSON.stringify(byTier)}`);
console.log(`要旨の長さ min/avg/max: ${Math.min(...L)} / ${Math.round(L.reduce((a, b) => a + b, 0) / L.length)} / ${Math.max(...L)}`);
console.log(`wrote ${OUT}`);
