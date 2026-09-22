import type { CollectMessage } from '../../env';
import { SOURCES } from '../domain';
import type { CollectQueue, ScheduleDeps } from './ports';

export type EnqueueProject = {
  project_id: string;
  summary: string;
  user_id: string;
  search_terms?: string[];
};

/** 1 プロジェクト × ソースぶんの Queue メッセージを組み立てる */
export function buildCollectBatch(
  projects: EnqueueProject[],
  opts: { runDate: string; runIdFor: (p: EnqueueProject) => string },
): { body: CollectMessage }[] {
  const messages: { body: CollectMessage }[] = [];
  for (const p of projects) {
    const runId = opts.runIdFor(p);
    for (const source of SOURCES) {
      messages.push({
        body: {
          run_id: runId,
          project_id: p.project_id,
          summary: p.summary,
          source,
          run_date: opts.runDate,
          user_id: p.user_id,
          search_terms: p.search_terms?.length ? p.search_terms : undefined,
        },
      });
    }
  }
  return messages;
}

export async function sendCollectBatch(
  queue: CollectQueue,
  messages: { body: CollectMessage }[],
): Promise<number> {
  for (let i = 0; i < messages.length; i += 100) {
    await queue.sendBatch(messages.slice(i, i + 100));
  }
  return messages.length;
}

export async function scheduleCollect(deps: ScheduleDeps): Promise<void> {
  const runDate = deps.clock.today();

  const fired = await deps.idempotency.get(`cron:${runDate}`);
  if (fired) return;

  const projects = await deps.projects.list();
  const messages = buildCollectBatch(projects, {
    runDate,
    runIdFor: (p) => `${p.project_id}:${runDate}`,
  });

  await sendCollectBatch(deps.queue, messages);
  await deps.idempotency.put(`cron:${runDate}`, '1', 60 * 60 * 24 * 3);
}

/** 自発調査。1 プロジェクトだけ Queue へ。HTTP 内では収集本体を回さない（FR-17） */
export async function enqueueManualCollect(
  deps: Pick<ScheduleDeps, 'clock' | 'queue'>,
  project: EnqueueProject,
  nowMs: number = Date.now(),
): Promise<{ run_id: string; enqueued: number; run_date: string }> {
  const runDate = deps.clock.today();
  const runId = `${project.project_id}:manual:${nowMs}`;
  const messages = buildCollectBatch([project], {
    runDate,
    runIdFor: () => runId,
  });
  const enqueued = await sendCollectBatch(deps.queue, messages);
  return { run_id: runId, enqueued, run_date: runDate };
}
