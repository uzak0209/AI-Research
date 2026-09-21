import type { CollectMessage } from '../../env';
import { SOURCES } from '../domain';
import type { ScheduleDeps } from './ports';

export async function scheduleCollect(deps: ScheduleDeps): Promise<void> {
  const runDate = deps.clock.today();

  const fired = await deps.idempotency.get(`cron:${runDate}`);
  if (fired) return;

  const projects = await deps.projects.list();

  const messages: { body: CollectMessage }[] = [];
  for (const p of projects) {
    const runId = `${p.project_id}:${runDate}`;
    for (const source of SOURCES) {
      messages.push({
        body: {
          run_id: runId,
          project_id: p.project_id,
          summary: p.summary,
          source,
          run_date: runDate,
        },
      });
    }
  }

  for (let i = 0; i < messages.length; i += 100) {
    await deps.queue.sendBatch(messages.slice(i, i + 100));
  }

  await deps.idempotency.put(`cron:${runDate}`, '1', 60 * 60 * 24 * 3);
}
