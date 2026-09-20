// ADR-0001 の 2 段目（ローカル埋め込みによる絞り込み）だけで、どこまで分離できるかを測る。
// 3 段目の生成 LLM が識別に失敗した場合に、どこまで 2 段目に頼れるかの判断材料。
//
//   node embed-bench.mjs --model=Xenova/bge-small-en-v1.5

import { pipeline, env } from '@huggingface/transformers';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import os from 'node:os';

env.cacheDir = './models';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const MODEL = args.model ?? 'Xenova/bge-small-en-v1.5';
const INPUT = args.input ?? 'fixtures/papers.json';

const { summary, papers } = JSON.parse(readFileSync(INPUT, 'utf8'));

console.log(`model=${MODEL} n=${papers.length}`);
const t0 = performance.now();
const extract = await pipeline('feature-extraction', MODEL);
const loadMs = performance.now() - t0;
console.log(`load: ${Math.round(loadMs)} ms\n`);

async function embed(text) {
  const out = await extract(text, { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0); // normalize 済みなので内積

const tq0 = performance.now();
const qv = await embed(summary);
const rows = [];
for (const p of papers) {
  const t = performance.now();
  const v = await embed(`${p.title}\n${p.abstract}`);
  rows.push({ id: p.id, expected: p.expected, tier: p.tier ?? null, label_confidence: p.label_confidence ?? null, sim: cos(qv, v), ms: performance.now() - t });
}
const embedMs = performance.now() - tq0;

rows.sort((a, b) => b.sim - a.sim);

console.log('順位  id   tier expected  sim');
rows.forEach((r, i) => {
  console.log(
    `${String(i + 1).padStart(4)}  ${r.id}  ${(r.tier ?? '-').padEnd(4)} ${r.expected.padEnd(8)}  ${r.sim.toFixed(4)}`,
  );
});

const U = rows.filter((r) => r.expected === 'useful').map((r) => r.sim);
const X = rows.filter((r) => r.expected === 'excluded').map((r) => r.sim);
const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;

// 上位 k 件に本当に useful が何件入るか（= 3 段目に通す件数を決める根拠）
const precAt = (k) => rows.slice(0, k).filter((r) => r.expected === 'useful').length / k;
const recallAt = (k) => rows.slice(0, k).filter((r) => r.expected === 'useful').length / U.length;
// useful を 1 件も落とさずに済む最小の k
const recallAll = rows.findLastIndex((r) => r.expected === 'useful') + 1;
const nUseful = U.length;

// 境界層（tier B）だけの分離。ここが実務で効く
const bRows = rows.filter((r) => r.tier === 'B');
const bU = bRows.filter((r) => r.expected === 'useful').map((r) => r.sim);
const bX = bRows.filter((r) => r.expected === 'excluded').map((r) => r.sim);

const result = {
  measured_at: new Date().toISOString(),
  machine: { cpu: os.cpus()[0]?.model?.trim(), logical_cores: os.cpus().length, node: process.version },
  config: { model: MODEL, input: INPUT, n: papers.length },
  load_ms: Math.round(loadMs),
  embed_total_ms: Math.round(embedMs),
  embed_per_item_ms: Math.round(embedMs / papers.length),
  mean_sim_useful: +avg(U).toFixed(4),
  mean_sim_excluded: +avg(X).toFixed(4),
  gap: +(avg(U) - avg(X)).toFixed(4),
  min_sim_useful: +Math.min(...U).toFixed(4),
  max_sim_excluded: +Math.max(...X).toFixed(4),
  separable: Math.min(...U) > Math.max(...X),
  n_useful: nUseful,
  precision_at_n_useful: +precAt(nUseful).toFixed(3),
  recall_at_n_useful: +recallAt(nUseful).toFixed(3),
  precision_at_2n: +precAt(Math.min(nUseful * 2, rows.length)).toFixed(3),
  recall_at_2n: +recallAt(Math.min(nUseful * 2, rows.length)).toFixed(3),
  k_for_full_recall: recallAll,
  k_for_full_recall_ratio: +(recallAll / rows.length).toFixed(3),
  tier_b: bRows.length
    ? {
        n: bRows.length,
        n_useful: bU.length,
        mean_sim_useful: bU.length ? +avg(bU).toFixed(4) : null,
        mean_sim_excluded: bX.length ? +avg(bX).toFixed(4) : null,
        separable: bU.length && bX.length ? Math.min(...bU) > Math.max(...bX) : null,
      }
    : null,
  rows,
};

console.log('\n--- summary ---');
console.log(`埋め込み 1 件        : ${result.embed_per_item_ms} ms`);
console.log(`平均 sim useful      : ${result.mean_sim_useful}`);
console.log(`平均 sim excluded    : ${result.mean_sim_excluded}  (差 ${result.gap})`);
console.log(`useful 最小 / excluded 最大 : ${result.min_sim_useful} / ${result.max_sim_excluded}`);
console.log(`閾値だけで完全分離   : ${result.separable ? 'できる' : 'できない'}`);
console.log(`precision@${nUseful}（useful 件数と同じ幅） : ${result.precision_at_n_useful}`);
console.log(`recall@${Math.min(nUseful * 2, rows.length)}（2 倍の幅を通す） : ${result.recall_at_2n}`);
console.log(`useful を全部拾うのに必要な上位件数 : ${result.k_for_full_recall} / ${papers.length}（${(result.k_for_full_recall_ratio * 100).toFixed(0)} %）`);
if (result.tier_b) {
  console.log(`境界層 tier B        : n=${result.tier_b.n} useful=${result.tier_b.n_useful} ` +
    `sim useful=${result.tier_b.mean_sim_useful} excluded=${result.tier_b.mean_sim_excluded} 分離=${result.tier_b.separable ? 'できる' : 'できない'}`);
}

mkdirSync('results', { recursive: true });
const tag = INPUT.includes('real') ? '-real' : '-synth';
const path = `results/embed-${MODEL.replace(/[^a-zA-Z0-9]+/g, '-')}${tag}.json`;
writeFileSync(path, JSON.stringify(result, null, 2), 'utf8');
console.log(`\nwrote ${path}`);
