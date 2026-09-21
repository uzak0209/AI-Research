/**
 * ADR-0005 §1 の 1 段目: `summary` から検索語を作る。
 *
 * 流れは固定:
 *   1. summary に**実際に書かれている語・短い句を抽出**する
 *   2. 日本語ならそれを英語に訳す（略語・ラテン固有名はそのまま）
 *   3. 英語側だけを OpenAlex のクエリにする
 *
 * 入り口を無制限に増やさせない（§7）:
 *   - 出力は対訳の配列に閉じる。任意 URL も任意ツールも渡さない
 *   - 件数に上限を置く
 *   - `source` が summary に字面で出てこない対は捨てる
 *   - ラテンの `source` に対し、無関係な `en` は捨てる
 *
 * LLM 失敗時はラテン種語だけ。日本語全文は OpenAlex に投げない（C-07）。
 */
import { chatCompletion, type OrcaChatOk } from '../../shared/orca/chat';
import { collectPolicy } from '../../shared/orca/policy';
import type { Env } from '../../env';

export const COLLECT_ENDPOINT = '/cron/collect';

/** 1 回の収集で使う検索語の上限。探索が発散すると取得件数と課金が跳ねる */
export const MAX_TERMS = 6;
/** これ未満の語は一致の意味が薄いので捨てる */
const MIN_TERM_LEN = 2;

const SYSTEM = [
  'You extract keywords from a research project summary (課題意識), then translate them into English search terms for OpenAlex.',
  'Step 1: Pick short words or phrases that literally appear in the summary (Japanese or English).',
  'Step 2: Translate each picked Japanese item into a concise English academic search term. Keep acronyms/proper nouns unchanged (e.g. DPDK → DPDK).',
  'Do not add topics that are not written in the summary.',
  'Reply with ONLY a JSON array of objects. No prose, no code fence.',
  `Format: [{"source":"<exact substring from summary>","en":"<English search term>"}]`,
  `At most ${MAX_TERMS} objects. "en" is 1-4 English words.`,
].join(' ');

export type TermPair = { source: string; en: string };

/** ラテン文字が少なく、和文からの抽出→英訳が必要か */
export function needsEnglishSearchTerms(summary: string): boolean {
  const chars = [...summary].filter((c) => /\S/u.test(c));
  if (chars.length === 0) return false;
  const latin = chars.filter((c) => /[A-Za-z]/.test(c)).length;
  return latin / chars.length < 0.35;
}

/**
 * LLM が使えないときの OpenAlex 向けフォールバック。
 * 日本語全文は載せない。ラテン技術語だけ拾う。
 */
export function openAlexQueryFromSummary(summary: string): string {
  const latin = [...summary.matchAll(/[A-Za-z][A-Za-z0-9_+.-]{1,31}/g)].map((m) => m[0]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of latin) {
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_TERMS) break;
  }
  return out.join(' ');
}

function looksLikeEnglishTerm(term: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+./\s-]{0,47}$/.test(term)) return false;
  const parts = term.trim().split(/\s+/).filter(Boolean);
  return parts.length >= 1 && parts.length <= 4;
}

function hasCjk(text: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(text);
}

/** source が summary に字面で含まれるか（ラテンは大小無視） */
function sourceInSummary(source: string, summary: string): boolean {
  const s = source.trim();
  if (s.length < MIN_TERM_LEN) return false;
  if (summary.includes(s)) return true;
  if (/^[A-Za-z0-9_+.-]+$/.test(s)) {
    return summary.toLowerCase().includes(s.toLowerCase());
  }
  return false;
}

/** ラテン source の en が、抜き出した語から乖離していないか */
function enFaithfulToSource(source: string, en: string): boolean {
  if (hasCjk(source)) return looksLikeEnglishTerm(en);
  const sw = source
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2);
  const ew = en
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2);
  if (sw.length === 0) return looksLikeEnglishTerm(en);
  return sw.some((w) => ew.some((e) => e.includes(w) || w.includes(e)));
}

/**
 * モデル出力を対訳配列として受け取る。
 * 形が違えば**捨てる**。source が summary に無い対・無関係な en も捨てる。
 */
export function parseTermPairs(raw: string, summary: string): TermPair[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const seenEn = new Set<string>();
  const out: TermPair[] = [];

  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as { source?: unknown; en?: unknown };
    const source = typeof rec.source === 'string' ? rec.source.trim() : '';
    const en = typeof rec.en === 'string' ? rec.en.trim() : '';
    if (!source || !en) continue;
    if (!sourceInSummary(source, summary)) continue;
    if (!looksLikeEnglishTerm(en)) continue;
    if (!enFaithfulToSource(source, en)) continue;

    const key = en.toLowerCase();
    if (seenEn.has(key)) continue;
    seenEn.add(key);
    out.push({ source, en });
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

/** OpenAlex に載せる英語側だけ。対訳形式専用 */
export function parseTerms(raw: string, summary: string): string[] {
  return parseTermPairs(raw, summary).map((p) => p.en);
}

export type SearchTerms = {
  /** 実際に投げる検索文字列 */
  query: string;
  /** LLM を使えたか。false ならフォールバック */
  generated: boolean;
  /** 記録用。generated が false でも、呼べたなら usage は残す（課金は発生している） */
  usage: OrcaChatOk | null;
};

export async function buildSearchQuery(env: Env, summary: string): Promise<SearchTerms> {
  const policy = collectPolicy(env);
  const apiKey = env.ORCAROUTER_API_KEY_CRON ?? env.ORCAROUTER_API_KEY;
  const fallback = openAlexQueryFromSummary(summary);

  if (!apiKey) {
    return { query: fallback, generated: false, usage: null };
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
    return { query: fallback, generated: false, usage: null };
  }

  const terms = parseTerms(result.text, summary);
  if (terms.length === 0) {
    return { query: fallback, generated: false, usage: result };
  }

  return { query: terms.join(' '), generated: true, usage: result };
}
