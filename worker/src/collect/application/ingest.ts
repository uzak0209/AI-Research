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

/**
 * 粗い一致を優先し、同点なら全文が読めるもの（OA 直 PDF あり）、その次に新しい順。
 * 読めない候補を上位に置いても読む順として役に立たない（ADR-0003）。
 */
export function pickTopPapers(papers: ScoredPaper[], take: number): ScoredPaper[] {
  return [...papers]
    .sort((a, b) => {
      const score = (b.coarse_score ?? 0) - (a.coarse_score ?? 0);
      if (score !== 0) return score;
      const pdf = (b.pdf_url ? 1 : 0) - (a.pdf_url ? 1 : 0);
      if (pdf !== 0) return pdf;
      return (b.published_at ?? '').localeCompare(a.published_at ?? '');
    })
    .slice(0, take);
}

export async function ingestCollect(deps: IngestDeps, raw: CollectMessage): Promise<void> {
  const parsed = collectMessageSchema.safeParse(raw);
  if (!parsed.success) throw new Error('invalid collect message');
  const msg = parsed.data;

  // 連続失敗の空回りを止める（ADR-0005 §7）。project × 当日の単位で見る。
  // 開いていれば Named Router を一切呼ばずに当日停止として残す
  const breakerScope = `${msg.project_id}:${msg.run_date}`;
  if (await deps.breaker.isOpen(breakerScope)) {
    const failure = 'サーキットブレーカー開放中: 当日のこの project は停止';
    await deps.runs.save(msg, [], failure, [], { trend: null, themes: [] });
    throw new Error(failure);
  }

  const search = await deps.search.build(msg.summary, msg.search_terms);
  if (search.usage) await deps.usage.recordSearch(msg, search.usage);

  let papers: ScoredPaper[] = [];
  let failure: string | null = null;

  try {
    const skipIds = new Set(await deps.runs.knownExternalIds(msg.project_id));
    const queries = (search.queries?.length ? search.queries : [search.query]).filter((q) => q.trim());
    // 検索語が取れないまま集めない。機能語を軸にすると無関係な論文が入る（C-07）
    if (queries.length === 0) throw new Error('検索語を作れなかった（LLM が全滅）');
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

  if (failure) await deps.breaker.recordFailure(breakerScope);
  else await deps.breaker.recordSuccess(breakerScope);

  let report = { trend: null as string | null, themes: [] as string[] };
  if (!failure && papers.length > 0) {
    try {
      const analyzed = await deps.trend.analyze(msg.summary, papers);
      report = analyzed.report;
      if (analyzed.usage) await deps.usage.recordTrend?.(msg, analyzed.usage);
    } catch {
      // 論文は残す。トレンドが欠けたことは報告で見せる（C-07）
    }
  }

  await deps.runs.save(msg, papers, failure, search.combo, report);
  if (failure) throw new Error(failure);
}
