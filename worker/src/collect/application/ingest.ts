import type { CollectMessage } from '../../env';
import { coarseScore, collectMessageSchema, type ScoredPaper } from '../domain';
import type { IngestDeps } from './ports';

export async function ingestCollect(deps: IngestDeps, raw: CollectMessage): Promise<void> {
  const parsed = collectMessageSchema.safeParse(raw);
  if (!parsed.success) throw new Error('invalid collect message');
  const msg = parsed.data;

  let papers: ScoredPaper[] = [];
  let failure: string | null = null;

  try {
    const fetched = await deps.papers.fetch(msg.source, msg.summary);
    papers = fetched.map((p) => ({
      ...p,
      coarse_score: coarseScore(msg.summary, `${p.title} ${p.abstract ?? ''}`),
    }));
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }

  await deps.runs.save(msg, papers, failure);
  if (failure) throw new Error(failure);
}
