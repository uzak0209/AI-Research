/**
 * 収集 2 段目: abstract から課題・限界を述べた短い引用だけを抜く（C-07: 捏造しない）。
 */
import type { Env } from '../../env';
import { chatCompletion, combineUsage, orcaKey, type OrcaChatOk } from '../../shared/orca/chat';
import { reviewPolicy, reviewSelfFallbackModel } from '../../shared/orca/policy';
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

export type ParsedProblemExcerpts = {
  /** false は JSON が壊れている・形が違う（＝形式不正。ADR-0005 §5） */
  ok: boolean;
  excerpts: Map<string, string | null>;
};

/** モデル出力を external_id → 引用 に正規化する。形が違えば全部 null（C-07） */
export function parseProblemExcerpts(
  raw: string,
  allowedIds: ReadonlySet<string>,
): ParsedProblemExcerpts {
  const excerpts = new Map<string, string | null>();
  for (const id of allowedIds) excerpts.set(id, null);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return { ok: false, excerpts };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, excerpts };
  }

  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!allowedIds.has(key)) continue;
    if (value === null) {
      excerpts.set(key, null);
      continue;
    }
    if (typeof value !== 'string') continue;
    const quote = value.trim();
    excerpts.set(key, quote.length > 0 ? quote : null);
  }
  return { ok: true, excerpts };
}

export type ProblemExcerptResult = {
  papers: ScoredPaper[];
  usage: OrcaChatOk | null;
};

export async function attachProblemExcerpts(env: Env, papers: ScoredPaper[]): Promise<ProblemExcerptResult> {
  const excerpts = new Map<string, string | null>();
  if (papers.length === 0) return { papers: [], usage: null };

  const policy = reviewPolicy(env);
  const apiKey = orcaKey(env, policy.slot);
  if (!apiKey) {
    return { papers: papers.map((p) => ({ ...p, problem_excerpt: null })), usage: null };
  }

  let usage: OrcaChatOk | null = null;
  for (let i = 0; i < papers.length; i += MAX_PAPERS_PER_CALL) {
    const batch = papers.slice(i, i + MAX_PAPERS_PER_CALL);
    const allowed = new Set(batch.map((p) => p.external_id));
    const messages = [
      { role: 'system' as const, content: SYSTEM },
      {
        role: 'user' as const,
        content: JSON.stringify(
          batch.map((p) => ({
            external_id: p.external_id,
            title: p.title,
            abstract: truncate(p.abstract),
          })),
        ),
      },
    ];

    const result = await chatCompletion(apiKey, messages, policy);
    if (!result.ok) {
      for (const p of batch) excerpts.set(p.external_id, excerpts.get(p.external_id) ?? null);
      continue;
    }
    usage = combineUsage(usage, result);
    let parsed = parseProblemExcerpts(result.text, allowed);

    // 形式不正（HTTP 200 だが JSON が壊れている）はゲートウェイでは拾えない。
    // 同じモデルに投げ直さず、別モデルへ 1 回だけ自前で投げ直す（ADR-0005 §5）。
    // レビュー段は同格のみへ落とす（安価モデルへ落とすと捏造率を実測していない出力が混入する）。
    if (!parsed.ok) {
      const fallbackModel = reviewSelfFallbackModel(result.model);
      if (fallbackModel) {
        const retry = await chatCompletion(apiKey, messages, { ...policy, model: fallbackModel, fallbacks: [] });
        if (retry.ok) {
          usage = combineUsage(usage, retry);
          parsed = parseProblemExcerpts(retry.text, allowed);
        }
      }
    }

    for (const [id, quote] of parsed.excerpts) excerpts.set(id, quote);
  }

  return {
    papers: papers.map((p) => ({
      ...p,
      problem_excerpt: excerpts.get(p.external_id) ?? null,
    })),
    usage,
  };
}
