// ADR-0001 の検証。Transformers.js(ONNX) の生成 LLM で採否判定が実用速度かを測る。
// 本番コードではない（AGENTS.md: prototypes/ は検証用）。
//
//   node bench.mjs --model=onnx-community/Qwen2.5-0.5B-Instruct --dtype=q4 --n=20
//
// 出るもの: モデル読込時間、1 件あたりの所要時間、プロンプト/生成トークン数、
//           JSON として解釈できた割合、人手ラベルとの一致率。

import { pipeline, env } from '@huggingface/transformers';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import os from 'node:os';

// モデルキャッシュはリポジトリ外に出さず、.gitignore 済みの models/ に置く
env.cacheDir = './models';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const MODEL = args.model ?? 'onnx-community/Qwen2.5-0.5B-Instruct';
const DTYPE = args.dtype ?? 'q4';
const MAX_NEW = Number(args.max_new_tokens ?? 96);
const INPUT = args.input ?? 'fixtures/papers.json';
const N = Number(args.n ?? 20);

const { summary, papers } = JSON.parse(readFileSync(INPUT, 'utf8'));
const items = papers.slice(0, N);

const SYSTEM = [
  'You screen newly published papers for a researcher.',
  'Decide whether the paper is USEFUL for the research project described by the user.',
  'Reply with JSON only, no prose, no markdown fence:',
  '{"verdict":"useful","reason":"<one short sentence>"}',
  'verdict must be exactly "useful" or "excluded".',
].join('\n');

const userMsg = (p) =>
  `Research project:\n${summary}\n\nPaper title: ${p.title}\n\nAbstract:\n${p.abstract}\n\nJSON:`;

// モデルが素直に JSON を返さない場合に備えて、最初の JSON オブジェクトを拾う
function parseVerdict(text) {
  const m = text.match(/\{[\s\S]*?\}/);
  if (!m) return { ok: false, verdict: null, reason: null };
  try {
    const o = JSON.parse(m[0]);
    const v = String(o.verdict ?? '').toLowerCase();
    if (v !== 'useful' && v !== 'excluded') return { ok: false, verdict: null, reason: o.reason ?? null };
    return { ok: true, verdict: v, reason: o.reason ?? null };
  } catch {
    return { ok: false, verdict: null, reason: null };
  }
}

const ms = (x) => Math.round(x);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.floor(s.length / 2);
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
};

console.log(`model=${MODEL} dtype=${DTYPE} max_new_tokens=${MAX_NEW} n=${items.length}`);
console.log(`cpu=${os.cpus()[0]?.model?.trim()} logical=${os.cpus().length} node=${process.version}`);

const tLoad0 = performance.now();
const gen = await pipeline('text-generation', MODEL, { dtype: DTYPE });
const loadMs = performance.now() - tLoad0;
console.log(`load: ${ms(loadMs)} ms\n`);

const tok = gen.tokenizer;
const countTokens = (text) => {
  try {
    return tok.encode(text).length;
  } catch {
    return null;
  }
};

async function judge(p) {
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: userMsg(p) },
  ];
  const t0 = performance.now();
  const out = await gen(messages, { max_new_tokens: MAX_NEW, do_sample: false });
  const elapsed = performance.now() - t0;

  // messages を渡した場合は会話配列が返る。文字列で返る実装差にも備える
  let text = out?.[0]?.generated_text;
  if (Array.isArray(text)) text = text.at(-1)?.content ?? '';
  if (typeof text !== 'string') text = String(text ?? '');

  const promptText = tok.apply_chat_template
    ? tok.apply_chat_template(messages, { tokenize: false, add_generation_prompt: true })
    : messages.map((m) => m.content).join('\n');

  return {
    id: p.id,
    expected: p.expected,
    tier: p.tier ?? null,
    label_confidence: p.label_confidence ?? null,
    elapsed_ms: elapsed,
    prompt_tokens: countTokens(String(promptText)),
    output_tokens: countTokens(text),
    raw: text.trim(),
    ...parseVerdict(text),
  };
}

// 1 件目は初回実行の重さを含むので warmup として本計測から外す
console.log('warmup...');
const warm = await judge(items[0]);
console.log(`warmup: ${ms(warm.elapsed_ms)} ms\n`);

const rows = [];
for (const [i, p] of items.entries()) {
  const r = await judge(p);
  rows.push(r);
  const hit = r.ok ? (r.verdict === r.expected ? 'o' : 'x') : '-';
  console.log(
    `${String(i + 1).padStart(2)}/${items.length} ${r.id} ${ms(r.elapsed_ms)
      .toString()
      .padStart(6)} ms  in=${r.prompt_tokens} out=${r.output_tokens}  ${(r.verdict ?? 'PARSE_FAIL').padEnd(9)} ${hit}`,
  );
}

const times = rows.map((r) => r.elapsed_ms);
const total = times.reduce((a, b) => a + b, 0);
const parsed = rows.filter((r) => r.ok);
const agreed = parsed.filter((r) => r.verdict === r.expected);
const outTokens = rows.map((r) => r.output_tokens ?? 0).reduce((a, b) => a + b, 0);

// 基準率が偏っている（実データは useful 3 割）ため、正答率だけでは
// 「全部 excluded」と答える退化した分類器を見抜けない。混同行列を必ず出す。
const tp = parsed.filter((r) => r.verdict === 'useful' && r.expected === 'useful').length;
const fp = parsed.filter((r) => r.verdict === 'useful' && r.expected === 'excluded').length;
const fn = parsed.filter((r) => r.verdict === 'excluded' && r.expected === 'useful').length;
const tn = parsed.filter((r) => r.verdict === 'excluded' && r.expected === 'excluded').length;
const precision = tp + fp ? tp / (tp + fp) : null;
const recall = tp + fn ? tp / (tp + fn) : null;
const f1 = precision && recall ? (2 * precision * recall) / (precision + recall) : null;
const dist = rows.reduce((a, r) => ((a[r.verdict ?? 'PARSE_FAIL'] = (a[r.verdict ?? 'PARSE_FAIL'] ?? 0) + 1), a), {});

const byTier = {};
for (const r of parsed) {
  const t = r.tier ?? '-';
  byTier[t] ??= { n: 0, ok: 0 };
  byTier[t].n++;
  if (r.verdict === r.expected) byTier[t].ok++;
}
for (const k of Object.keys(byTier)) byTier[k].rate = +(byTier[k].ok / byTier[k].n).toFixed(3);

// 確信度の低いラベルを除いた場合の一致率（ラベル側の揺れの影響を見る）
const confident = parsed.filter((r) => r.label_confidence !== 'low');
const agreedConfident = confident.filter((r) => r.verdict === r.expected).length;

const summaryOut = {
  measured_at: new Date().toISOString(),
  machine: { cpu: os.cpus()[0]?.model?.trim(), logical_cores: os.cpus().length, total_mem_gb: +(os.totalmem() / 1024 ** 3).toFixed(1), node: process.version, platform: `${os.platform()} ${os.release()}` },
  config: { model: MODEL, dtype: DTYPE, max_new_tokens: MAX_NEW, n: items.length, input: INPUT },
  load_ms: ms(loadMs),
  warmup_ms: ms(warm.elapsed_ms),
  per_item_ms: { min: ms(Math.min(...times)), median: ms(median(times)), mean: ms(total / times.length), max: ms(Math.max(...times)) },
  total_ms: ms(total),
  total_with_load_ms: ms(total + loadMs),
  throughput_tok_per_s: +((outTokens / total) * 1000).toFixed(2),
  json_parse_rate: +(parsed.length / rows.length).toFixed(3),
  label_agreement: parsed.length ? +(agreed.length / parsed.length).toFixed(3) : null,
  label_agreement_excl_low_confidence: confident.length ? +(agreedConfident / confident.length).toFixed(3) : null,
  verdict_distribution: dist,
  base_rate_useful: +(rows.filter((r) => r.expected === 'useful').length / rows.length).toFixed(3),
  confusion: { tp, fp, fn, tn },
  precision_useful: precision === null ? null : +precision.toFixed(3),
  recall_useful: recall === null ? null : +recall.toFixed(3),
  f1_useful: f1 === null ? null : +f1.toFixed(3),
  agreement_by_tier: byTier,
  rows,
};

console.log('\n--- summary ---');
console.log(`load                 : ${summaryOut.load_ms} ms`);
console.log(`per item (median)    : ${summaryOut.per_item_ms.median} ms`);
console.log(`per item (min/max)   : ${summaryOut.per_item_ms.min} / ${summaryOut.per_item_ms.max} ms`);
console.log(`${items.length} 件 合計         : ${(summaryOut.total_ms / 1000).toFixed(1)} s (読込込み ${(summaryOut.total_with_load_ms / 1000).toFixed(1)} s)`);
console.log(`生成スループット     : ${summaryOut.throughput_tok_per_s} tok/s`);
console.log(`JSON として解釈できた: ${(summaryOut.json_parse_rate * 100).toFixed(0)} %`);
console.log(`verdict の分布       : ${JSON.stringify(dist)}  (useful の基準率 ${(summaryOut.base_rate_useful * 100).toFixed(0)} %)`);
console.log(`人手ラベルとの一致   : ${summaryOut.label_agreement === null ? 'n/a' : (summaryOut.label_agreement * 100).toFixed(0) + ' %'} (解釈できた ${parsed.length} 件中)`);
console.log(`  確信度 low を除くと : ${summaryOut.label_agreement_excl_low_confidence === null ? 'n/a' : (summaryOut.label_agreement_excl_low_confidence * 100).toFixed(0) + ' %'}`);
console.log(`混同行列 (正=useful) : tp=${tp} fp=${fp} fn=${fn} tn=${tn}`);
console.log(`precision / recall / F1 : ${summaryOut.precision_useful} / ${summaryOut.recall_useful} / ${summaryOut.f1_useful}`);
console.log(`tier 別一致          : ${Object.entries(byTier).map(([k, v]) => `${k}=${(v.rate * 100).toFixed(0)}%(${v.ok}/${v.n})`).join(' ')}`);

mkdirSync('results', { recursive: true });
const slug = `${MODEL.replace(/[^a-zA-Z0-9]+/g, '-')}-${DTYPE}`;
const path = `results/${slug}.json`;
writeFileSync(path, JSON.stringify(summaryOut, null, 2), 'utf8');
console.log(`\nwrote ${path}`);
