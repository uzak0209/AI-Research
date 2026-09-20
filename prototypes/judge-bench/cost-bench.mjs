// 概要を含める／含めないで推論時間がどう変わるかを分解して測る。
//
//   node cost-bench.mjs
//
// 費用の構造:
//   起動時に 1 回  : プロフィール側（概要・主張）の埋め込み
//   論文 1 件ごとに: 論文の埋め込み 1 回 ＋ 内積 数回
// 採点方式が変えるのは「起動時」と「内積の回数」だけで、論文の埋め込みは共通。

import { pipeline, env } from '@huggingface/transformers';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

env.cacheDir = './models';

const MODEL = 'Xenova/bge-small-en-v1.5';
const profile = JSON.parse(readFileSync('fixtures/profile.json', 'utf8'));
const papers = JSON.parse(readFileSync('fixtures/papers-real.json', 'utf8')).papers;

const extract = await pipeline('feature-extraction', MODEL);
const embed = async (t) => {
  const o = await extract(t, { pooling: 'mean', normalize: true });
  return Array.from(o.data);
};
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.floor(s.length / 2);
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
};

await embed('warmup'); // 初回の重さを除く

// --- 起動時に 1 回だけかかる分 -------------------------------------------
let t = performance.now();
const summaryVec = await embed(profile.summary);
const summaryMs = performance.now() - t;

t = performance.now();
const claimVecs = [];
for (const c of profile.claims) claimVecs.push(await embed(c.text));
const claimsMs = performance.now() - t;

// --- 論文 1 件ごとにかかる分 ---------------------------------------------
const embedTimes = [];
const paperVecs = [];
for (const p of papers) {
  const t0 = performance.now();
  const v = await embed(`${p.title}\n${p.abstract}`);
  embedTimes.push(performance.now() - t0);
  paperVecs.push(v);
}

// 内積のコスト。1 回では測れないので繰り返して割る
const REP = 2000;
t = performance.now();
for (let i = 0; i < REP; i++) dot(summaryVec, paperVecs[i % paperVecs.length]);
const dot1Ms = (performance.now() - t) / REP;

t = performance.now();
for (let i = 0; i < REP; i++) {
  const v = paperVecs[i % paperVecs.length];
  dot(summaryVec, v);
  for (const cv of claimVecs) dot(cv, v);
}
const dot11Ms = (performance.now() - t) / REP;

const perPaper = med(embedTimes);
const dim = summaryVec.length;

console.log(`model=${MODEL}  次元=${dim}  論文=${papers.length} 件  主張=${profile.claims.length} 件\n`);

console.log('--- 起動時に 1 回だけ ---');
console.log(`  概要の埋め込み          : ${summaryMs.toFixed(1)} ms`);
console.log(`  主張 ${String(profile.claims.length).padStart(2)} 件の埋め込み     : ${claimsMs.toFixed(1)} ms`);

console.log('\n--- 論文 1 件ごと ---');
console.log(`  論文の埋め込み（中央値）: ${perPaper.toFixed(1)} ms   ← 全方式で共通`);
console.log(`  内積 1 回（概要のみ）   : ${dot1Ms.toFixed(4)} ms`);
console.log(`  内積 11 回（概要＋主張）: ${dot11Ms.toFixed(4)} ms`);
console.log(`  内積の差                : ${(dot11Ms - dot1Ms).toFixed(4)} ms`);

const modes = [
  { name: 'summary（概要のみ）', setup: summaryMs, per: perPaper + dot1Ms },
  { name: 'claims（主張のみ）', setup: claimsMs, per: perPaper + dot11Ms - dot1Ms },
  { name: 'blend（概要＋主張）', setup: summaryMs + claimsMs, per: perPaper + dot11Ms },
];

console.log('\n--- 方式ごとの合計 ---');
console.log('  方式                  起動時      論文1件      50件         500件');
for (const m of modes) {
  const f = (n) => ((m.setup + m.per * n) / 1000).toFixed(2) + ' s';
  console.log(
    `  ${m.name.padEnd(20)}  ${m.setup.toFixed(0).padStart(4)} ms   ${m.per.toFixed(1).padStart(5)} ms   ${f(50).padStart(8)}   ${f(500).padStart(8)}`,
  );
}

const diff50 = modes[2].setup + modes[2].per * 50 - (modes[0].setup + modes[0].per * 50);
const diff500 = modes[2].setup + modes[2].per * 500 - (modes[0].setup + modes[0].per * 500);
console.log(`\nblend と summary の差: 50 件で ${diff50.toFixed(0)} ms / 500 件で ${diff500.toFixed(0)} ms`);
console.log(`論文の埋め込みが占める割合（blend・50 件）: ${(((perPaper * 50) / (modes[2].setup + modes[2].per * 50)) * 100).toFixed(1)} %`);
