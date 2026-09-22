/**
 * ADR-0005 §1 の 1 段目: 検索語を作る。
 *
 * 流れ:
 *   1. summary から種になるラテン略語を取る
 *   2. 同じ分野の関連略語を LLM が 20 件以上推測する
 *   3. 種語単独 ＋ 種語×各略語の AND を全部 OpenAlex に当て、公開日の新しい順で取る
 *
 * 時間はかけてよい（NFR-01）。精度優先。乱択で組み合わせを間引かない。
 *
 * 入り口を無制限に増やさせない（§7）:
 *   - 出力は略語の配列に閉じる。任意 URL も任意ツールも渡さない
 *   - 推測プールに上限を置く
 *   - 分野を跨ぐ語・略語の形でないものは捨てる
 *
 * LLM 失敗時は種語だけ。日本語全文は OpenAlex に投げない（C-07）。
 */
import { chatCompletion, type OrcaChatOk } from '../../shared/orca/chat';
import { collectPolicy, type OrcaClassPolicy } from '../../shared/orca/policy';
import type { Env } from '../../env';

export const COLLECT_ENDPOINT = '/cron/collect';
export const KEYWORDS_ENDPOINT = '/bff/keywords';

/** 推測で足す略語の下限。プロンプトに書く */
export const MIN_INFERRED_ABBR = 20;
/** 推測プールの上限。これ以上は捨てる */
export const MAX_INFERRED_ABBR = 40;
/** summary から取る種語の上限 */
export const MAX_SEED_TERMS = 6;
/** 内部で集めて粗い順位を付ける件数。利用者に渡すのは COLLECT_DELIVER */
export const COLLECT_POOL = 80;
/** 利用者に渡す件数 */
export const COLLECT_DELIVER = 5;
/** 1 組み合わせあたり OpenAlex から取る新規の上限 */
export const PER_COMBO_TAKE = 25;
/** 1 組み合わせあたり見るページ数（新しい順）。時間はかけてよいがサブリクエストは残す */
export const PER_COMBO_PAGES = 2;
/** 1 収集で当てる組み合わせ数の上限（種語＋略語 AND） */
export const MAX_COMBO_QUERIES = 22;

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

export function isInferredAbbreviation(term: string): boolean {
  const t = term.trim();
  if (!t || /\s/.test(t) || t.length < 2 || t.length > 12) return false;
  if (!/^[A-Za-z][A-Za-z0-9_+.-]*$/.test(t)) return false;
  if ((t.match(/[A-Z]/g) ?? []).length >= 2) return true;
  return /\d/.test(t);
}

/** OpenAlex の search は空白区切りが AND */
export function andSearchQuery(terms: string[]): string {
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
  return out.join(' ');
}

export function parseSearchTermsJson(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      if (typeof item !== 'string') continue;
      const t = item.trim();
      if (!t) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
    return out;
  } catch {
    return [];
  }
}

export function openAlexQueryFromTerms(terms: string[]): string {
  return andSearchQuery(terms);
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
  return andSearchQuery(extractLatinTerms(summary));
}

/**
 * 精度優先のクエリ列。種語だけで最新を取り、続けて種語×各略語を AND する。
 * 時間をかけて全部当てる（NFR-01）。
 */
export function preciseSearchQueries(summary: string, inferred: string[]): string[] {
  const seeds = extractLatinTerms(summary);
  const primary = seeds[0] ?? null;
  const seedKeys = new Set(seeds.map((s) => s.toLowerCase()));
  const extras = inferred.filter((t) => !seedKeys.has(t.toLowerCase()));
  const queries: string[] = [];
  if (primary) queries.push(primary);
  for (const t of extras) {
    queries.push(primary ? andSearchQuery([primary, t]) : t);
  }
  return queries.filter(Boolean);
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

export type SearchTerms = {
  query: string;
  queries: string[];
  generated: boolean;
  usage: OrcaChatOk | null;
  combo: string[];
};

export async function buildSearchQuery(env: Env, summary: string): Promise<SearchTerms> {
  const policy = collectPolicy(env);
  const apiKey = env.ORCAROUTER_API_KEY_CRON ?? env.ORCAROUTER_API_KEY;
  const fallbackQueries = preciseSearchQueries(summary, []);
  const fallback: SearchTerms = {
    query: fallbackQueries[0] ?? '',
    queries: fallbackQueries,
    generated: false,
    usage: null,
    combo: extractLatinTerms(summary),
  };

  if (!apiKey) return fallback;

  const result = await chatCompletion(
    apiKey,
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: summary },
    ],
    policy,
  );

  if (!result.ok) return fallback;

  const inferred = parseInferredAbbreviations(result.text);
  if (inferred.length === 0) {
    return { ...fallback, usage: result };
  }

  const queries = preciseSearchQueries(summary, inferred);
  return {
    query: queries[0] ?? '',
    queries,
    generated: true,
    usage: result,
    combo: inferred,
  };
}

const KEYWORD_SYSTEM = [
  'You extract search keywords from a research problem statement.',
  'Reply with ONLY a JSON array of strings. No prose, no code fence.',
  `At least ${MIN_INFERRED_ABBR} items, at most ${MAX_INFERRED_ABBR}.`,
  'Each item is a short keyword used in the SAME subfield: abbreviations (DPDK, XDP) or short technical terms (2-24 characters).',
  'Japanese short nouns are OK when the topic is Japanese. No sentences. No URLs. No paper titles.',
  'Do not jump to another field.',
].join(' ');

/** 設定画面の確認用。略語に限らず短いキーワードを残す */
export function parseKeywordTags(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string') continue;
    const t = item.trim().replace(/\s+/g, ' ');
    if (!t || t.length > 24) continue;
    if (/https?:\/\//i.test(t) || t.includes('://')) continue;
    if ((t.match(/ /g) ?? []).length > 2) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_INFERRED_ABBR) break;
  }
  return out;
}

export function mergeKeywordTags(base: string[], extra: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...base, ...extra]) {
    const x = t.trim().replace(/\s+/g, ' ');
    if (!x) continue;
    const key = x.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(x);
    if (out.length >= MAX_INFERRED_ABBR) break;
  }
  return out;
}

/** 課題意識からキーワード。利用者が設定で確認する（C-07）。原稿は載せない */
export async function inferKeywords(
  apiKey: string,
  policy: OrcaClassPolicy,
  summary: string,
): Promise<{ terms: string[]; usage: OrcaChatOk | null }> {
  const seeds = extractLatinTerms(summary);
  const result = await chatCompletion(
    apiKey,
    [
      { role: 'system', content: KEYWORD_SYSTEM },
      { role: 'user', content: summary },
    ],
    { ...policy, maxTokens: Math.max(policy.maxTokens ?? 0, 400) },
  );
  if (!result.ok) {
    return { terms: seeds, usage: null };
  }
  const inferred = parseKeywordTags(result.text);
  return {
    terms: mergeKeywordTags(seeds, inferred.length ? inferred : parseInferredAbbreviations(result.text)),
    usage: result,
  };
}
