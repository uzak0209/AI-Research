/**
 * ADR-0005 §1 の 1 段目: 検索語を作る。
 *
 * 流れ:
 *   1. **LLM が課題意識を分解する**。主題語（core）と同分野の関連語（related）に分ける
 *   2. core 単独 ＋ core×各関連語の AND を全部 OpenAlex に当て、公開日の新しい順で取る
 *
 * 分解を LLM に任せるのは、文章の先頭から機械的に英単語を拾うと
 * `The` `goal` `of` のような機能語が検索の軸になるため。
 * モデルが落ちたときの受け皿は Named Router が持つ（`routers/rs-collect.yaml`）。
 * コード側に語の切り出しを残さない。
 *
 * 時間はかけてよい（NFR-01）。精度優先。乱択で組み合わせを間引かない。
 *
 * 入り口を無制限に増やさせない（§7）:
 *   - 出力は語の配列に閉じる。任意 URL も任意ツールも渡さない
 *   - 推測プールに上限を置く
 *   - 分野を跨ぐ語・語の形でないものは捨てる
 *
 * LLM 失敗時は絞った種語だけ。日本語全文は OpenAlex に投げない（C-07）。
 */
import { chatCompletion, orcaKey, type OrcaChatOk } from '../../shared/orca/chat';
import { collectPolicy, type OrcaClassPolicy } from '../../shared/orca/policy';
import type { Env } from '../../env';

export const COLLECT_ENDPOINT = '/cron/collect';
export const KEYWORDS_ENDPOINT = '/bff/keywords';

/** 推測で足す略語の下限。プロンプトに書く */
export const MIN_INFERRED_ABBR = 20;
/** 推測プールの上限。これ以上は捨てる */
export const MAX_INFERRED_ABBR = 40;
/** 検索の軸にする主題語の上限。多いと AND が絞りすぎる */
export const MAX_CORE_TERMS = 3;
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
  'You decompose a research problem statement into OpenAlex search terms.',
  'Reply with ONLY a JSON object. No prose, no code fence.',
  'Format: {"core":["DPDK"],"related":["RSS","XDP","eBPF"]}',
  '"core": 1-4 terms that pin down THIS topic and nothing else.',
  'Pick the distinctive technical term or acronym. Translate Japanese into the English term researchers use.',
  'Never put function or generic words in "core" (the, of, goal, reducing, learning, neural networks).',
  `"related": at least ${MIN_INFERRED_ABBR} and at most ${MAX_INFERRED_ABBR} abbreviations and acronyms used in the SAME subfield.`,
  'Do not jump to another field (e.g. no biology terms for packet I/O).',
  'Do not invent URLs. Do not call tools. Do not write full English phrases.',
  'Every item is 2-12 Latin characters (letters, digits, + _ - .) with no spaces.',
].join(' ');

/**
 * 検索の軸にならない語。機械的な種語抽出（LLM 失敗時）で機能語を拾わないため。
 * LLM の出力にも当てる——`core` に `the` が来たら軸にしない。
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'not', 'no', 'of', 'to', 'in', 'on', 'at', 'by', 'for',
  'with', 'from', 'as', 'into', 'over', 'under', 'between', 'during', 'while', 'than', 'then',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did', 'done', 'can', 'may',
  'this', 'that', 'these', 'those', 'it', 'its', 'we', 'our', 'they', 'their', 'he', 'she',
  'how', 'what', 'why', 'when', 'where', 'which', 'who',
  'also', 'both', 'each', 'other', 'others', 'same', 'such', 'very', 'much', 'many', 'few',
  'more', 'most', 'less', 'least', 'first', 'second', 'new', 'novel',
  // 分野を絞れない一般名詞・動詞。軸に置くと何にでも当たる
  'goal', 'goals', 'paper', 'papers', 'study', 'studies', 'work', 'works', 'problem', 'problems',
  'approach', 'approaches', 'method', 'methods', 'result', 'results', 'use', 'used', 'using',
  'based', 'via', 'reducing', 'increasing', 'improving', 'proposed', 'propose',
]);

/** OpenAlex のクエリ語として使えるか。空白を含む句と機能語は軸にしない */
export function isQueryAxisTerm(term: string): boolean {
  const t = term.trim();
  if (!isDistinctiveSearchTerm(t)) return false;
  return !STOPWORDS.has(t.toLowerCase());
}

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

/**
 * 精度優先のクエリ列。主題語だけで最新を取り、続けて主題語×各関連語を AND する。
 * 時間をかけて全部当てる（NFR-01）。
 */
export function preciseSearchQueries(core: string[], related: string[]): string[] {
  const axes = core.filter(isQueryAxisTerm);
  const primary = axes[0] ?? null;
  if (!primary) return [];
  const coreKeys = new Set(axes.map((s) => s.toLowerCase()));
  const extras = related.filter((t) => !coreKeys.has(t.toLowerCase()));
  const queries: string[] = [andSearchQuery(axes)];
  for (const t of extras) {
    queries.push(andSearchQuery([primary, t]));
  }
  return queries.filter(Boolean);
}

/** モデル出力を略語配列として受け取る。形が違えば捨てる */
export function parseInferredAbbreviations(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(raw));
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { related?: unknown })?.related)
      ? (parsed as { related: unknown[] }).related
      : null;
  if (!list) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
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

function stripFence(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
}

export type Decomposed = { core: string[]; related: string[] };

/** 課題意識の分解。core は検索の軸にできる語だけ。形が違えば空（C-07） */
export function parseSearchDecomposition(raw: string): Decomposed {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(raw));
  } catch {
    return { core: [], related: [] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { core: [], related: [] };
  }
  const o = parsed as { core?: unknown; related?: unknown };

  const core: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(o.core)) {
    for (const item of o.core) {
      const t = typeof item === 'string' ? item.trim() : '';
      if (!isQueryAxisTerm(t)) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      core.push(t);
      if (core.length >= MAX_CORE_TERMS) break;
    }
  }

  return { core, related: parseInferredAbbreviations(JSON.stringify(o.related ?? [])) };
}

export type SearchTerms = {
  query: string;
  queries: string[];
  generated: boolean;
  usage: OrcaChatOk | null;
  combo: string[];
};

/**
 * 設定で確定した語を OpenAlex のクエリ列にする。
 * 先頭を軸にし、残りは軸×各語の AND。空白入りの術語はそのまま 1 クエリにする。
 */
export function queriesFromConfirmedTerms(terms: string[]): string[] {
  const combo = mergeKeywordTags([], terms);
  if (combo.length === 0) return [];

  const primary = combo[0]!;
  const queries: string[] = [primary];
  const axes = combo.filter(isQueryAxisTerm);
  if (axes.length > 1) {
    const together = andSearchQuery(axes.slice(0, MAX_CORE_TERMS));
    if (together && !queries.includes(together)) queries.unshift(together);
  }
  for (const t of combo.slice(1)) {
    const q = `${primary} ${t}`.replace(/\s+/g, ' ').trim();
    if (q && !queries.includes(q)) queries.push(q);
    if (queries.length >= MAX_COMBO_QUERIES) break;
  }
  return queries.slice(0, MAX_COMBO_QUERIES);
}

/** 確定語があればそれを使う。空・不正だけなら null（呼び出し側が LLM に落とす） */
export function searchTermsFromConfirmed(raw?: readonly string[] | null): SearchTerms | null {
  const combo = mergeKeywordTags([], [...(raw ?? [])]);
  if (combo.length === 0) return null;
  const queries = queriesFromConfirmedTerms(combo);
  if (queries.length === 0) return null;
  return {
    query: queries[0] ?? '',
    queries,
    generated: false,
    usage: null,
    combo,
  };
}

const EMPTY_TERMS: SearchTerms = {
  query: '',
  queries: [],
  generated: false,
  usage: null,
  combo: [],
};

/**
 * 分解は LLM に任せる。落ちたときの受け皿も LLM——**それは Named Router の仕事**。
 *
 * `rs-collect` が候補 3 本と受け皿 1 本を持ち、`extra_body.route=fallback` で
 * 別ベンダーへも落ちる（`routers/rs-collect.yaml`, ADR-0005 §3 / §5）。
 * だからここでモデルを段積みしない。呼ぶのは 1 回。
 *
 * その受け皿ごと全滅したら、**機械的な語の切り出しには落とさない**——
 * `The` のような機能語が検索の軸になり、関係の無い論文を集めてしまう。
 * 空で返し、収集を失敗として残す（C-07）。
 */
export async function buildSearchQuery(
  env: Env,
  summary: string,
  confirmed?: readonly string[] | null,
): Promise<SearchTerms> {
  const saved = searchTermsFromConfirmed(confirmed);
  if (saved) return saved;

  const policy = collectPolicy(env);
  const apiKey = orcaKey(env, policy.slot);
  if (!apiKey) return EMPTY_TERMS;

  const result = await chatCompletion(
    apiKey,
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: summary },
    ],
    policy,
    true,
  );
  if (!result.ok) return EMPTY_TERMS;

  const { core, related } = parseSearchDecomposition(result.text);
  const queries = preciseSearchQueries(core, related);
  if (queries.length === 0) return { ...EMPTY_TERMS, usage: result };

  return {
    query: queries[0] ?? '',
    queries,
    generated: true,
    usage: result,
    combo: mergeKeywordTags(core, related),
  };
}

const KEYWORD_SYSTEM = [
  'You decompose a research problem statement into OpenAlex search keywords.',
  'Reply with ONLY a JSON object. No prose, no code fence.',
  'Format: {"core":["DPDK","packet I/O"],"related":["RSS","XDP","eBPF"]}',
  '"core": 1-4 keywords that pin down THIS topic. Put them first because the user reads them first.',
  `"related": at least ${MIN_INFERRED_ABBR} and at most ${MAX_INFERRED_ABBR} keywords used in the SAME subfield.`,
  'Every item MUST be English: an abbreviation (DPDK, XDP) or a short Latin technical term (2-24 characters).',
  'If the problem is Japanese, translate into the English term researchers use (ゼロコピー → zero-copy, 自己注意 → self-attention).',
  'Never emit Japanese script. Never emit function or filler words (the, of, goal, reducing, operations, learning).',
  'No sentences. No URLs. No paper titles. Do not jump to another field.',
].join(' ');

function parseJsonBlob(raw: string): unknown | undefined {
  const trimmed = stripFence(raw);
  try {
    return JSON.parse(trimmed);
  } catch {
    /* 前後の散文を捨てて {…} / […] だけ拾う */
  }
  const objStart = trimmed.indexOf('{');
  const objEnd = trimmed.lastIndexOf('}');
  const arrStart = trimmed.indexOf('[');
  const arrEnd = trimmed.lastIndexOf(']');
  try {
    if (objStart >= 0 && objEnd > objStart && (arrStart < 0 || objStart <= arrStart)) {
      return JSON.parse(trimmed.slice(objStart, objEnd + 1));
    }
    if (arrStart >= 0 && arrEnd > arrStart) {
      return JSON.parse(trimmed.slice(arrStart, arrEnd + 1));
    }
  } catch {
    return undefined;
  }
  return undefined;
}

const KEYWORD_LIST_KEYS = ['core', 'related', 'terms', 'keywords', 'tags'] as const;

function keywordItems(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return [];
  const o = parsed as Record<string, unknown>;
  const list: unknown[] = [];
  for (const key of KEYWORD_LIST_KEYS) {
    if (Array.isArray(o[key])) list.push(...o[key]);
  }
  return list;
}

/**
 * 設定画面の確認用。OpenAlex 向けなのでラテン文字の短い語だけ残す。
 * `{"core":[…],"related":[…]}` でも `{"terms":[…]}` でも素の配列でも読む（core が先）。
 */
export function parseKeywordTags(raw: string): string[] {
  const list = keywordItems(parseJsonBlob(raw));

  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const t = item.trim().replace(/\s+/g, ' ');
    if (!t || t.length > 24) continue;
    if (/https?:\/\//i.test(t) || t.includes('://')) continue;
    if ((t.match(/ /g) ?? []).length > 2) continue;
    if (/[\u3040-\u30ff\u3400-\u9fff]/.test(t)) continue;
    if (STOPWORDS.has(t.toLowerCase())) continue;
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

/** 設定画面は待たせすぎない。json_object は無料モデルが止まることがあるので付けない */
const KEYWORD_TIMEOUT_MS = 25_000;

/**
 * 課題意識からキーワード。利用者が設定で確認する（C-07）。原稿は載せない。
 * 分解は LLM。取れなければ空で返し、文章から語を切り出して埋めたふりをしない。
 */
export async function inferKeywords(
  apiKey: string,
  policy: OrcaClassPolicy,
  summary: string,
): Promise<{ terms: string[]; usage: OrcaChatOk | null }> {
  const result = await chatCompletion(
    apiKey,
    [
      { role: 'system', content: KEYWORD_SYSTEM },
      { role: 'user', content: summary },
    ],
    { ...policy, maxTokens: Math.max(policy.maxTokens ?? 0, 600) },
    false,
    KEYWORD_TIMEOUT_MS,
  );
  if (!result.ok) {
    return { terms: [], usage: null };
  }
  const tags = parseKeywordTags(result.text);
  return {
    terms: tags.length ? tags : parseInferredAbbreviations(result.text),
    usage: result,
  };
}
