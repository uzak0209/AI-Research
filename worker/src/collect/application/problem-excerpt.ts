/**
 * 収集 2 段目: abstract から課題・限界を述べた短い引用だけを抜く（C-07: 捏造しない）。
 */
import type { Env } from '../../env';
import { chatCompletion, orcaKey, type OrcaChatOk } from '../../shared/orca/chat';
import { reviewPolicy } from '../../shared/orca/policy';
import type { ScoredPaper } from '../domain';

export const REVIEW_ENDPOINT = '/cron/review';

const MAX_PAPERS = 20;
const ABSTRACT_MAX = 800;

const SYSTEM = [
  'For each paper, extract ONLY a short verbatim quote from the abstract that states the problem, challenge, or limitation.',
  'Reply with ONLY a JSON object: keys are external_id strings, values are the quote string or null if none.',
  'Do not paraphrase or invent text not present in the abstract.',
  'No prose, no code fence.',
].join(' ');

function truncate(text: string | null): string {
  if (!text) return '';
  const t = text.trim();
  return t.length <= ABSTRACT_MAX ? t : `${t.slice(0, ABSTRACT_MAX)}…`;
}

/** モデル出力を external_id → 引用 に正規化する。形が違えば全部 null（C-07） */
export function parseProblemExcerpts(
  raw: string,
  allowedIds: ReadonlySet<string>,
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const id of allowedIds) out.set(id, null);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return out;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return out;

  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!allowedIds.has(key)) continue;
    if (value === null) {
      out.set(key, null);
      continue;
    }
    if (typeof value !== 'string') continue;
    const quote = value.trim();
    out.set(key, quote.length > 0 ? quote : null);
  }
  return out;
}

export type ProblemExcerptResult = {
  papers: ScoredPaper[];
  usage: OrcaChatOk | null;
};

export async function attachProblemExcerpts(env: Env, papers: ScoredPaper[]): Promise<ProblemExcerptResult> {
  const withNull = papers.map((p) => ({ ...p, problem_excerpt: null as string | null }));
  if (papers.length === 0) return { papers: withNull, usage: null };

  const policy = reviewPolicy(env);
  const apiKey = orcaKey(env, policy.slot);
  if (!apiKey) return { papers: withNull, usage: null };

  const batch = papers.slice(0, MAX_PAPERS);
  const allowed = new Set(batch.map((p) => p.external_id));
  const payload = batch.map((p) => ({
    external_id: p.external_id,
    title: p.title,
    abstract: truncate(p.abstract),
  }));

  const result = await chatCompletion(
    apiKey,
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: JSON.stringify(payload) },
    ],
    policy,
  );

  if (!result.ok) return { papers: withNull, usage: null };

  const excerpts = parseProblemExcerpts(result.text, allowed);
  const merged = papers.map((p) => ({
    ...p,
    problem_excerpt: excerpts.get(p.external_id) ?? null,
  }));

  return { papers: merged, usage: result };
}
