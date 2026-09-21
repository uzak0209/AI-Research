/**
 * ADR-0005 §1 の 1 段目: 検索語を作る。
 *
 * 流れ:
 *   1. summary から種になるラテン略語を取る
 *   2. 同じ分野の関連略語を LLM が 20 件以上推測する（summary に無い語も足す）
 *   3. プールから組み合わせを乱択し、英語略語だけを OpenAlex に載せる
 *
 * 入り口を無制限に増やさせない（§7）:
 *   - 出力は略語の配列に閉じる。任意 URL も任意ツールも渡さない
 *   - 推測プールと 1 回あたりの組み合わせサイズに上限を置く
 *   - 分野を跨ぐ語・略語の形でないものは捨てる
 *
 * LLM 失敗時は種語だけ。日本語全文は OpenAlex に投げない（C-07）。
 */
import { chatCompletion, type OrcaChatOk } from '../../shared/orca/chat';
import { collectPolicy } from '../../shared/orca/policy';
import type { Env } from '../../env';

export const COLLECT_ENDPOINT = '/cron/collect';

/** 推測で足す略語の下限。プロンプトに書く */
export const MIN_INFERRED_ABBR = 20;
/** 推測プールの上限。これ以上は捨てる */
export const MAX_INFERRED_ABBR = 40;
/** 1 回の収集で乱択する関連略語の数（種語は別途必ず載せる） */
export const COMBO_SIZE = 5;
/** summary から取る種語の上限 */
export const MAX_SEED_TERMS = 6;

/** 旧名・テスト互換。推測プールの上限と同じ */
export const MAX_TERMS = MAX_INFERRED_ABBR;

const SYSTEM = [
  'You expand a research project summary into related technical abbreviations for OpenAlex.',
  'Infer abbreviations and acronyms used in the SAME subfield as the summary.',
  'Include abbreviations that appear in the summary, then add related ones that researchers in that subfield actually use.',
  'Do not jump to another field (e.g. no biology terms for packet I/O).',
  'Do not invent URLs. Do not call tools. Do not write full English phrases.',
  'Reply with ONLY a JSON array of strings. No prose, no code fence.',
  `Format: ["DPDK","RSS","XDP","eBPF",...]`,
  `At least ${MIN_INFERRED_ABBR} items, at most ${MAX_INFERRED_ABBR}.`,
  'Each item is 2-12 Latin characters (letters, digits, + _ - .).',
].join(' ');

export function defaultRand(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return (buf[0] as number) / 0x1_0000_0000;
}

/** Fisher–Yates。テストでは rand を差し込む */
export function pickRandomSubset<T>(items: T[], n: number, rand: () => number = defaultRand): T[] {
  if (n <= 0 || items.length === 0) return [];
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const a = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = a;
  }
  return copy.slice(0, Math.min(n, copy.length));
}

export function isInferredAbbreviation(term: string): boolean {
  const t = term.trim();
  if (!t || /\s/.test(t) || t.length < 2 || t.length > 12) return false;
  if (!/^[A-Za-z][A-Za-z0-9_+.-]*$/.test(t)) return false;
  if ((t.match(/[A-Z]/g) ?? []).length >= 2) return true;
  return /\d/.test(t);
}

export function openAlexQueryFromTerms(terms: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of terms) {
    const x = t.trim();
    if (!x || /\s/.test(x)) continue;
    const key = x.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(x);
  }
  return out.join(' OR ');
}

export function isDistinctiveSearchTerm(term: string): boolean {
  return isInferredAbbreviation(term) || /^[A-Za-z][A-Za-z0-9_+.-]{1,11}$/.test(term.trim());
}

export function extractLatinTerms(summary: string): string[] {
  const latin = [...summary.matchAll(/[A-Za-z][A-Za-z0-9_+.-]{1,31}/g)].map((m) => m[0]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of latin) {
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_SEED_TERMS) break;
  }
  return out;
}

export function openAlexQueryFromSummary(summary: string): string {
  return openAlexQueryFromTerms(extractLatinTerms(summary));
}

/** モデル出力を略語配列として受け取る。形が違えば捨てる */
export function parseInferredAbbreviations(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of parsed) {
    const t = typeof item === 'string' ? item.trim() : '';
    if (!isInferredAbbreviation(t)) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_INFERRED_ABBR) break;
  }
  return out;
}

export function collectSearchCombo(
  summary: string,
  inferred: string[],
  opts: { rand?: () => number; comboSize?: number } = {},
): { query: string; combo: string[] } {
  const seeds = extractLatinTerms(summary);
  const seedKeys = new Set(seeds.map((s) => s.toLowerCase()));
  const extra = inferred.filter((t) => !seedKeys.has(t.toLowerCase()));
  const picked = pickRandomSubset(extra, opts.comboSize ?? COMBO_SIZE, opts.rand ?? defaultRand);
  const combo = [...seeds, ...picked];
  return { query: openAlexQueryFromTerms(combo), combo };
}

export type SearchTerms = {
  query: string;
  generated: boolean;
  usage: OrcaChatOk | null;
  combo: string[];
};

export async function buildSearchQuery(
  env: Env,
  summary: string,
  opts: { rand?: () => number } = {},
): Promise<SearchTerms> {
  const policy = collectPolicy(env);
  const apiKey = env.ORCAROUTER_API_KEY_CRON ?? env.ORCAROUTER_API_KEY;
  const fallbackCombo = collectSearchCombo(summary, [], { rand: () => 0 });

  if (!apiKey) {
    return { query: fallbackCombo.query, generated: false, usage: null, combo: fallbackCombo.combo };
  }

  const result = await chatCompletion(
    apiKey,
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: summary },
    ],
    policy,
  );

  if (!result.ok) {
    return { query: fallbackCombo.query, generated: false, usage: null, combo: fallbackCombo.combo };
  }

  const inferred = parseInferredAbbreviations(result.text);
  if (inferred.length === 0) {
    return {
      query: fallbackCombo.query,
      generated: false,
      usage: result,
      combo: fallbackCombo.combo,
    };
  }

  const picked = collectSearchCombo(summary, inferred, { rand: opts.rand });
  return { query: picked.query, generated: true, usage: result, combo: picked.combo };
}
