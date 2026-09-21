/**
 * ADR-0005 §1 の 1 段目: `summary` から検索語を作る。
 *
 * ここが「入り口を AI に選ばせる」唯一の場所。ただし**入り口を無制限に増やさせない**（§7）:
 *   - 出力は検索語の配列に閉じる。任意 URL も任意ツールも渡さない
 *   - 件数に上限を置く
 *   - `summary` に出てくる語と重ならない検索語は捨てる（勝手に話題を広げない）
 *
 * 失敗したら**検索語を捏造せず** `summary` をそのまま使う（C-07）。
 * 収集自体は続く。LLM が無くても日次収集は止まらない（NFR-01）。
 */
import { chatCompletion, type OrcaChatOk } from '../../shared/orca/chat';
import { collectPolicy } from '../../shared/orca/policy';
import type { Env } from '../../env';

export const COLLECT_ENDPOINT = '/cron/collect';

/** 1 回の収集で使う検索語の上限。探索が発散すると取得件数と課金が跳ねる */
export const MAX_TERMS = 6;
/** これ未満の語は一致の意味が薄いので捨てる */
const MIN_TERM_LEN = 3;

const SYSTEM = [
  'You turn a research project summary into search terms for an academic paper database.',
  'Reply with ONLY a JSON array of strings. No prose, no code fence.',
  `At most ${MAX_TERMS} terms. Each term is 1-4 words, taken from the vocabulary of the summary.`,
  'Do not invent new research topics that the summary does not mention.',
].join(' ');

/** 比較のために正規化する。記号を落として小文字化するだけ */
function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(' ')
      .filter((w) => w.length >= MIN_TERM_LEN),
  );
}

/**
 * モデルの出力を検索語の配列として受け取る。
 * 形が違えば**捨てる**。部分的に直して使わない（何を検索したか分からなくなる）。
 */
export function parseTerms(raw: string, summary: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const vocab = words(summary);
  const seen = new Set<string>();
  const out: string[] = [];

  for (const item of parsed) {
    if (typeof item !== 'string') continue;
    const term = item.trim();
    if (term.length < MIN_TERM_LEN) continue;

    const key = term.toLowerCase();
    if (seen.has(key)) continue;

    // summary の語と 1 つも重ならない検索語は、AI が話題を広げた結果。採らない
    const overlaps = [...words(term)].some((w) => vocab.has(w));
    if (!overlaps) continue;

    seen.add(key);
    out.push(term);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

export type SearchTerms = {
  /** 実際に投げる検索文字列 */
  query: string;
  /** LLM を使えたか。false なら summary をそのまま使った */
  generated: boolean;
  /** 記録用。generated が false でも、呼べたなら usage は残す（課金は発生している） */
  usage: OrcaChatOk | null;
};

export async function buildSearchQuery(env: Env, summary: string): Promise<SearchTerms> {
  const policy = collectPolicy(env);
  const apiKey = env.ORCAROUTER_API_KEY_CRON ?? env.ORCAROUTER_API_KEY;

  // 鍵が無ければ黙って素通り。収集は続ける
  if (!apiKey) return { query: summary, generated: false, usage: null };

  const result = await chatCompletion(
    apiKey,
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: summary },
    ],
    policy,
  );

  if (!result.ok) return { query: summary, generated: false, usage: null };

  const terms = parseTerms(result.text, summary);
  // 形が違った・全部弾かれた場合も summary に戻す。呼び出し自体は課金済みなので記録は残す
  if (terms.length === 0) return { query: summary, generated: false, usage: result };

  return { query: terms.join(' '), generated: true, usage: result };
}
