import type { CollectMessage } from '../../env';
import { coarseScore, collectMessageSchema, type ScoredPaper } from '../domain';
import type { IngestDeps } from './ports';

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
    const fetched = await deps.papers.fetch(msg.source, search.query);
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
