// クラウドから run をプルしてローカル papers に載せる（FR-02 / ADR-0001）。
// 採点はここではしない。メインが utilityProcess を起動する。

import type { CloudClient } from '@ai-research/core';
import type { Db } from './db.js';
import { getProject, listChunks, parseSearchTerms, setLastRunId, setLastSearchTerms, upsertPapers, upsertSurveyReport } from './repo.js';

/** クラウド収集材料。課題意識＋関連技術（未公開の提案手法は載せない）。 */
export function cloudSummaryFromLocal(
  problem: string,
  relatedTech: { text: string }[],
): string {
  const tech = relatedTech.map((c) => c.text.trim()).filter(Boolean);
  const head = problem.trim();
  if (tech.length === 0) return head;
  const block = tech.join('\n');
  return head ? `${head}\n\n${block}` : block;
}

export async function syncProjectFromCloud(
  db: Db,
  client: CloudClient,
  projectId: string,
): Promise<{
  inserted: number;
  pulled: number;
  lastRunId: string | null;
  statuses: string[];
  searchTerms: string[];
}> {
  const project = getProject(db, projectId);
  if (!project) throw new Error(`project not found: ${projectId}`);

  const summary = cloudSummaryFromLocal(project.summary, listChunks(db, projectId));
  await client.putProject(projectId, { title: project.title, summary });

  const { runs } = await client.pullRuns(projectId, project.last_run_id);

  let inserted = 0;
  let pulled = 0;
  const statuses: string[] = [];
  let searchTerms: string[] = parseSearchTerms(project.last_search_terms);
  for (const run of runs ?? []) {
    statuses.push(run.status);
    if (run.search_terms?.length) searchTerms = run.search_terms;
    const papers = run.papers ?? [];
    pulled += papers.length;
    inserted += upsertPapers(
      db,
      projectId,
      papers.map((p) => ({
        external_id: p.external_id,
        source: p.source,
        title: p.title,
        authors: p.authors,
        abstract: p.abstract,
        url: p.url,
        published_at: p.published_at,
        pdf_url: p.pdf_url ?? null,
        coarse_score: p.coarse_score,
        problem_excerpt: p.problem_excerpt,
        run_id: run.run_id,
      })),
    );
    upsertSurveyReport(db, {
      run_id: run.run_id,
      project_id: projectId,
      run_date: run.run_date,
      status: run.status,
      search_terms: run.search_terms,
      trend: run.trend,
      themes: run.themes,
      created_at: run.created_at,
    });
  }

  const lastRunId = runs.length > 0 ? runs[runs.length - 1]!.run_id : project.last_run_id;
  if (runs.length > 0) {
    setLastRunId(db, projectId, lastRunId);
    if (searchTerms.length) setLastSearchTerms(db, projectId, searchTerms);
  }

  return { inserted, pulled, lastRunId, statuses, searchTerms };
}
