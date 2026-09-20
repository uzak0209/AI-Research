// 関連度ランキング（Transformers.js のみ / 生成 LLM を使わない）
//
// ADR-0001 の 2 段目だけで「関連度順の提示」を行う。実測は FINDINGS.md。
//
//   node rank.mjs --top=20
//   node rank.mjs --score=claims                  # 概要を使わず自分の主張だけで採点
//   node rank.mjs --exclude-tier=C                # クラウドが粗く絞った後を模した評価
//   node rank.mjs --papers=... --profile=... --json=results/ranked.json
//
// 出すもの: 関連度順の一覧と、各論文が**自分のどの主張に最も近いか**。
// 後者は最近傍という事実であって判定ではない。判定・理由付けはしない（生成 LLM を使わないため）。

import { pipeline, env } from '@huggingface/transformers';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import path from 'node:path';

env.cacheDir = './models';

const DEFAULTS = {
  model: 'Xenova/bge-small-en-v1.5',
  papers: 'fixtures/papers-real.json',
  profile: 'fixtures/profile.json',
  top: null,
  json: null,
  score: 'blend',
  'exclude-tier': null, // 例: C。クラウドが落とすはずの層を除いて評価する
  'only-tier': null,
};

/**
 * 関連度の出し方。
 * @param simSummary プロジェクト概要との cos
 * @param claimSims  自分の主張それぞれとの cos（降順）
 */
const SCORERS = {
  // 概要との近さだけ。クラウドが概要で絞った後だと分散が小さくなる想定
  summary: (simSummary) => simSummary,
  // 概要を使わず、最も近い自分の主張との近さだけ
  claims: (_s, claimSims) => claimSims[0]?.sim ?? -1,
  // 上位 3 つの主張の平均。1 つの主張への偶発的な食いつきを薄める
  'claims-top3': (_s, claimSims) => {
    const t = claimSims.slice(0, 3);
    return t.length ? t.reduce((a, c) => a + c.sim, 0) / t.length : -1;
  },
  // 概要を主、主張を従として混ぜる
  blend: (simSummary, claimSims) => 0.7 * simSummary + 0.3 * (claimSims[0]?.sim ?? simSummary),
  // 概要と主張の高い方
  max: (simSummary, claimSims) => Math.max(simSummary, claimSims[0]?.sim ?? -1),
};

// --- 中核: ここだけをアプリ側へ持っていけるようにしておく -------------------

const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0); // 正規化済みなので内積 = cos

/**
 * 論文を関連度順に並べる。判定はしない。
 * @param {{summary: string, claims?: {id: string, text: string}[]}} profile
 * @param {{id: string, title: string, abstract: string}[]} papers
 */
export async function rankPapers(profile, papers, { model = DEFAULTS.model, score = DEFAULTS.score, onProgress } = {}) {
  const scorer = SCORERS[score];
  if (!scorer) throw new Error(`未知の score: ${score}（${Object.keys(SCORERS).join(' | ')}）`);
  if (score.startsWith('claims') && !profile.claims?.length) {
    throw new Error(`score=${score} は profile.claims が要る（空なので採点できない）`);
  }

  const t0 = performance.now();
  const extract = await pipeline('feature-extraction', model);
  const loadMs = performance.now() - t0;

  const embed = async (text) => {
    const out = await extract(text, { pooling: 'mean', normalize: true });
    return Array.from(out.data);
  };

  const summaryVec = await embed(profile.summary);
  const claimVecs = [];
  for (const c of profile.claims ?? []) claimVecs.push({ ...c, vec: await embed(c.text) });

  const tEmbed = performance.now();
  const rows = [];
  for (const [i, p] of papers.entries()) {
    const v = await embed(`${p.title}\n${p.abstract}`);
    const simSummary = dot(summaryVec, v);

    // 自分のどの主張に近いか。最近傍という事実だけを出す（判定ではない）
    const claimSims = claimVecs
      .map((c) => ({ id: c.id, sim: dot(c.vec, v), text: c.text }))
      .sort((a, b) => b.sim - a.sim);

    rows.push({
      id: p.id,
      title: p.title,
      score: scorer(simSummary, claimSims),
      sim_summary: simSummary,
      claim_sims: claimSims.map(({ id, sim }) => ({ id, sim })),
      nearest_claim: claimSims[0] ? { id: claimSims[0].id, sim: claimSims[0].sim, text: claimSims[0].text } : null,
      tier: p.tier ?? null,
      expected: p.expected ?? null,
      year: p.year ?? null,
      doi: p.doi ?? null,
    });
    onProgress?.(i + 1, papers.length);
  }
  const embedMs = performance.now() - tEmbed;

  rows.sort((a, b) => b.score - a.score);
  rows.forEach((r, i) => (r.rank = i + 1));

  return {
    rows,
    stats: {
      model,
      score_mode: score,
      n: papers.length,
      load_ms: Math.round(loadMs),
      embed_total_ms: Math.round(embedMs),
      embed_per_item_ms: Math.round(embedMs / Math.max(papers.length, 1)),
    },
  };
}

// --- CLI -------------------------------------------------------------------

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
  const args = { ...DEFAULTS };
  for (const a of process.argv.slice(2)) {
    const [k, v] = a.replace(/^--/, '').split('=');
    args[k] = v ?? true;
  }

  const profile = JSON.parse(readFileSync(args.profile, 'utf8'));
  const papersDoc = JSON.parse(readFileSync(args.papers, 'utf8'));
  let papers = papersDoc.papers ?? papersDoc;

  if (!profile.summary) {
    console.error(`${args.profile} に summary がない。プロフィールなしでは関連度を出せない。`);
    process.exit(1);
  }
  if (!profile.claims?.length) {
    // 「主張が空」と「近い主張が無い」を混ぜない（C-07）
    console.warn('注意: profile.claims が空。自分のどの主張に近いかは出せず、概要との近さだけになる。\n');
  }

  const before = papers.length;
  if (args['exclude-tier']) papers = papers.filter((p) => p.tier !== args['exclude-tier']);
  if (args['only-tier']) papers = papers.filter((p) => p.tier === args['only-tier']);
  const filtered = before !== papers.length;

  console.log(`model=${args.model}  score=${args.score}  papers=${args.papers}  profile=${args.profile}`);
  if (filtered) {
    console.log(
      `層で絞り込み: ${before} -> ${papers.length} 件` +
        (args['exclude-tier'] ? `（tier ${args['exclude-tier']} を除外 = クラウドが落とした想定）` : '') +
        (args['only-tier'] ? `（tier ${args['only-tier']} のみ）` : ''),
    );
  }
  console.log(`論文 ${papers.length} 件 / 自分の主張 ${profile.claims?.length ?? 0} 件\n`);

  const { rows, stats } = await rankPapers(profile, papers, {
    model: args.model,
    score: args.score,
    onProgress: (i, n) => {
      if (i % 10 === 0 || i === n) process.stdout.write(`  埋め込み ${i}/${n}\r`);
    },
  });
  process.stdout.write('\n\n');

  const top = args.top ? Number(args.top) : rows.length;
  for (const r of rows.slice(0, top)) {
    const claim = r.nearest_claim ? `${r.nearest_claim.id} (${r.nearest_claim.sim.toFixed(3)})` : '-';
    console.log(
      `${String(r.rank).padStart(4)}  ${r.score.toFixed(4)}  ${claim.padEnd(14)}  ${r.tier ?? '-'}  ${r.title.slice(0, 56)}`,
    );
  }

  console.log(`\n読込 ${stats.load_ms} ms / 埋め込み ${stats.embed_per_item_ms} ms per 件 / 合計 ${(stats.embed_total_ms / 1000).toFixed(1)} s`);

  if (rows.some((r) => r.expected)) {
    const nUseful = rows.filter((r) => r.expected === 'useful').length;
    console.log(
      `\n--- 参考: 人手ラベルとの突き合わせ（${rows.length} 件中 useful ${nUseful} 件 / 基準率 ${((nUseful / rows.length) * 100).toFixed(0)} %）---`,
    );

    // 同じ埋め込みから全方式を比べる（再計算は不要）
    console.log('  方式          取りこぼしゼロに必要な件数   上位30%の recall   採点値の散らばり');
    for (const [name, fn] of Object.entries(SCORERS)) {
      const re = [...rows]
        .map((r) => ({ ...r, s: fn(r.sim_summary, r.claim_sims) }))
        .sort((a, b) => b.s - a.s);
      const k = re.findLastIndex((r) => r.expected === 'useful') + 1;
      const k30 = Math.max(1, Math.round(rows.length * 0.3));
      const r30 = re.slice(0, k30).filter((r) => r.expected === 'useful').length / nUseful;
      // 採点値の標準偏差。小さいほど差が付かず順位が不安定になる
      const vals = re.map((r) => r.s);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
      console.log(
        `  ${name.padEnd(12)}  ${String(k).padStart(3)} / ${rows.length}（${String(Math.round((k / rows.length) * 100)).padStart(2)} %）` +
          `            ${String(Math.round(r30 * 100)).padStart(3)} %` +
          `            sd=${sd.toFixed(4)}${name === args.score ? '  <- 今回' : ''}`,
      );
    }
  }

  if (args.json) {
    mkdirSync(path.dirname(args.json), { recursive: true });
    writeFileSync(args.json, JSON.stringify({ stats, rows }, null, 2), 'utf8');
    console.log(`\nwrote ${args.json}`);
  }
}
