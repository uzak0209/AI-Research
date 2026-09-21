import type { CollectMessage } from '../../env';
import type { FetchedPaper } from '../../shared/papers/domain';
import { coarseScore, collectMessageSchema, type ScoredPaper } from '../domain';
import type { IngestDeps } from './ports';
import {
  COLLECT_TAKE,
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

export async function ingestCollect(deps: IngestDeps, raw: CollectMessage): Promise<void> {
  const parsed = collectMessageSchema.safeParse(raw);
  if (!parsed.success) throw new Error('invalid collect message');
  const msg = parsed.data;

  // 1 段目: summary から検索語を作る（ADR-0005 §1）。
  // 失敗しても summary をそのまま使って収集は続ける（NFR-01, C-07）
  const search = await deps.search.build(msg.summary);

  // 呼べたぶんは必ず記録する。検索語が採れなくても課金は発生している
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

    const fetched = mergeLatestPapers(collected, COLLECT_TAKE);
    const scored = fetched.map((p) => ({
      ...p,
      coarse_score: coarseScore(msg.summary, `${p.title} ${p.abstract ?? ''}`),
      problem_excerpt: null as string | null,
    }));
    const excerpt = await deps.problemExcerpt.attach(scored);
    papers = excerpt.papers;
    if (excerpt.usage) await deps.usage.recordReview(msg, excerpt.usage);
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }

  await deps.runs.save(msg, papers, failure);
  if (failure) throw new Error(failure);
}
