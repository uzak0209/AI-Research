// クラウドから run をプルしてローカル papers に載せる（FR-02 / ADR-0001）。
// 採点はここではしない。メインが utilityProcess を起動する。

import type { CloudClient } from '@ai-research/core';
import type { Db } from './db.js';
import { getProject, setLastRunId, upsertPapers } from './repo.js';

export async function syncProjectFromCloud(
  db: Db,
  client: CloudClient,
  projectId: string,
): Promise<{ inserted: number; lastRunId: string | null }> {
  const project = getProject(db, projectId);
  if (!project) throw new Error(`project not found: ${projectId}`);

  await client.putProject(projectId, { title: project.title, summary: project.summary });

  const { runs } = await client.pullRuns(projectId, project.last_run_id);

  let inserted = 0;
  for (const run of runs) {
    inserted += upsertPapers(
      db,
      projectId,
      run.papers.map((p) => ({
        external_id: p.external_id,
        source: p.source,
        title: p.title,
        abstract: p.abstract,
        url: p.url,
        published_at: p.published_at,
        coarse_score: p.coarse_score,
        problem_excerpt: p.problem_excerpt,
        run_id: run.run_id,
      })),
    );
  }

  const lastRunId = runs.length > 0 ? runs[runs.length - 1]!.run_id : project.last_run_id;
  if (runs.length > 0) {
    setLastRunId(db, projectId, lastRunId);
  }

  return { inserted, lastRunId };
}
