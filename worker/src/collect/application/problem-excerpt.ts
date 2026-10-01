/**
 * 収集 2 段目: abstract から課題・限界を述べた短い引用だけを抜く（C-07: 捏造しない）。
 */
import type { Env } from '../../env';
import { chatCompletion, orcaKey, type OrcaChatOk } from '../../shared/orca/chat';
import { reviewPolicy } from '../../shared/orca/policy';
import type { ScoredPaper } from '../domain';

export const REVIEW_ENDPOINT = '/cron/review';

const MAX_PAPERS_PER_CALL = 20;
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

function addUsage(a: OrcaChatOk | null, b: OrcaChatOk): OrcaChatOk {
  if (!a) return b;
  return {
    ...b,
    tokens: a.tokens + b.tokens,
    tokensIn: a.tokensIn + b.tokensIn,
    tokensOut: a.tokensOut + b.tokensOut,
    costUsd: a.costUsd == null || b.costUsd == null ? null : a.costUsd + b.costUsd,
    latencyMs: a.latencyMs + b.latencyMs,
    fallbackUsed: a.fallbackUsed || b.fallbackUsed,
  };
}

/**
 * problem_excerpt が abstract に逐語で実在するかの照合（捏造検知。C-07, FR-16, ADR-0005 §10）。
 * ローカルの文字列比較のみ。外部 LLM を再度呼ばない。
 * 空白の連続・前後の省略記号だけを正規化する。パラフレーズは検出できない前提（逐語一致のみ判定）。
 */
export function verifyProblemExcerpt(excerpt: string | null, abstract: string | null): boolean | null {
  if (!excerpt) return null;
  if (!abstract) return false;
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const quote = normalize(excerpt).replace(/^[…"'“”]+|[…"'“”]+$/g, '');
  if (!quote) return null;
  return normalize(abstract).includes(quote);
}

export async function attachProblemExcerpts(env: Env, papers: ScoredPaper[]): Promise<ProblemExcerptResult> {
  const excerpts = new Map<string, string | null>();
  if (papers.length === 0) return { papers: [], usage: null };

  const policy = reviewPolicy(env);
  const apiKey = orcaKey(env, policy.slot);
  if (!apiKey) {
    return {
      papers: papers.map((p) => ({ ...p, problem_excerpt: null, problem_excerpt_verified: null })),
      usage: null,
    };
  }

  let usage: OrcaChatOk | null = null;
  for (let i = 0; i < papers.length; i += MAX_PAPERS_PER_CALL) {
    const batch = papers.slice(i, i + MAX_PAPERS_PER_CALL);
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
    if (!result.ok) {
      for (const p of batch) excerpts.set(p.external_id, excerpts.get(p.external_id) ?? null);
      continue;
    }
    usage = addUsage(usage, result);
    const parsed = parseProblemExcerpts(result.text, allowed);
    for (const [id, quote] of parsed) excerpts.set(id, quote);
  }

  return {
    papers: papers.map((p) => {
      const problem_excerpt = excerpts.get(p.external_id) ?? null;
      return {
        ...p,
        problem_excerpt,
        problem_excerpt_verified: verifyProblemExcerpt(problem_excerpt, p.abstract),
      };
    }),
    usage,
  };
}
