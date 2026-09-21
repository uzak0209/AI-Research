import type { CollectMessage } from '../../env';
import type { FetchedPaper } from '../../shared/papers/domain';
import { coarseScore, collectMessageSchema, type ScoredPaper } from '../domain';
import type { IngestDeps } from './ports';
import {
  COLLECT_DELIVER,
  COLLECT_POOL,
  MAX_COMBO_QUERIES,
  PER_COMBO_PAGES,
  PER_COMBO_TAKE,
} from './search-terms';

export function mergeLatestPapers(papers: FetchedPaper[], take: number): FetchedPaper[] {
  const byId = new Map<string, FetchedPaper>();
  for (const p of papers) {
    if (!byId.has(p.external_id)) byId.set(p.external_id, p);
  }
  return [...byId.values()]
    .sort((a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? ''))
    .slice(0, take);
}

/** 粗い一致を優先し、同点なら新しい順。利用者に渡す上位だけ残す */
export function pickTopPapers(papers: ScoredPaper[], take: number): ScoredPaper[] {
  return [...papers]
    .sort((a, b) => {
      const score = (b.coarse_score ?? 0) - (a.coarse_score ?? 0);
      if (score !== 0) return score;
      return (b.published_at ?? '').localeCompare(a.published_at ?? '');
    })
    .slice(0, take);
}

export async function ingestCollect(deps: IngestDeps, raw: CollectMessage): Promise<void> {
  const parsed = collectMessageSchema.safeParse(raw);
  if (!parsed.success) throw new Error('invalid collect message');
  const msg = parsed.data;

  const search = await deps.search.build(msg.summary);
  if (search.usage) await deps.usage.recordSearch(msg, search.usage);

  let papers: ScoredPaper[] = [];
  let failure: string | null = null;

  try {
    const skipIds = new Set(await deps.runs.knownExternalIds(msg.project_id));
    const queries = (search.queries?.length ? search.queries : [search.query]).filter((q) => q.trim());
    const collected: FetchedPaper[] = [];
    let queriesRun = 0;

    for (const q of queries) {
      if (queriesRun >= MAX_COMBO_QUERIES) break;
      const batch = await deps.papers.fetch(msg.source, q, {
        skipIds,
        take: PER_COMBO_TAKE,
        maxPages: PER_COMBO_PAGES,
      });
      queriesRun += 1;
      for (const p of batch) {
        if (skipIds.has(p.external_id)) continue;
        skipIds.add(p.external_id);
        collected.push(p);
      }
    }

    const pooled = mergeLatestPapers(collected, COLLECT_POOL);
    const scored = pooled.map((p) => ({
      ...p,
      coarse_score: coarseScore(msg.summary, `${p.title} ${p.abstract ?? ''}`),
      problem_excerpt: null as string | null,
    }));
    const top = pickTopPapers(scored, COLLECT_DELIVER);
    const excerpt = await deps.problemExcerpt.attach(top);
    papers = excerpt.papers;
    if (excerpt.usage) await deps.usage.recordReview(msg, excerpt.usage);
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }

  await deps.runs.save(msg, papers, failure, search.combo);
  if (failure) throw new Error(failure);
}
