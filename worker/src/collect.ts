import { sql } from 'kysely';
import { utcDate } from './date';
import { batch, execute } from './db/execute';
import { db } from './db/kysely';
import type { CollectMessage, Env } from './env';
import { fetchFromSource } from './openalex';
import { collectMessageSchema } from './schema';
import { coarseScore } from './score';

/** 収集ソース。アダプタで足す（ADR-0001 の拡張点） */
export const SOURCES = ['openalex'] as const;

/** D1 の 1 文あたりのバインド変数の上限 */
const D1_MAX_BIND_PARAMS = 100;
/** run_papers に 1 行あたり入れる列数 */
const RUN_PAPER_COLUMNS = 8;

/**
 * cron は Queues への投入だけを行う。収集本体はコンシューマ側。
 * ここで収集すると全プロジェクト分が CPU 10ms に収まらない。
 */
export async function handleScheduled(env: Env): Promise<void> {
  const runDate = utcDate();

  const fired = await env.IDEMPOTENCY.get(`cron:${runDate}`);
  if (fired) return;

  const projects = await execute<{ project_id: string; summary: string }>(
    env.DB,
    db.selectFrom('projects').select(['project_id', 'summary']).compile(),
  );

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
    await env.COLLECT_QUEUE.sendBatch(messages.slice(i, i + 100));
  }

  await env.IDEMPOTENCY.put(`cron:${runDate}`, '1', { expirationTtl: 60 * 60 * 24 * 3 });
}

export async function handleQueueMessage(msg: CollectMessage, env: Env): Promise<void> {
  const parsed = collectMessageSchema.safeParse(msg);
  if (!parsed.success) throw new Error('invalid collect message');
  msg = parsed.data;

  let papers: Awaited<ReturnType<typeof fetchFromSource>> = [];
  let failure: string | null = null;

  try {
    papers = await fetchFromSource(msg.source, msg.summary, { apiKey: env.OPENALEX_API_KEY });
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }

  const status = failure ? 'failed' : papers.length === 0 ? 'empty' : 'ok';
  const failedJson = failure ? JSON.stringify([{ source: msg.source, error: failure }]) : null;

  const statements = [
    sql`
      INSERT INTO runs (run_id, project_id, run_date, status, failed_sources_json)
      VALUES (${msg.run_id}, ${msg.project_id}, ${msg.run_date}, ${status}, ${failedJson})
      ON CONFLICT (project_id, run_date) DO UPDATE SET
        status = CASE
          WHEN runs.status = excluded.status THEN runs.status
          ELSE 'partial'
        END,
        failed_sources_json = COALESCE(excluded.failed_sources_json, runs.failed_sources_json)
    `.compile(db),
  ];

  if (papers.length > 0) {
    const CHUNK = Math.floor(D1_MAX_BIND_PARAMS / RUN_PAPER_COLUMNS);
    for (let i = 0; i < papers.length; i += CHUNK) {
      const chunk = papers.slice(i, i + CHUNK);
      statements.push(
        db
          .insertInto('run_papers')
          .values(
            chunk.map((p) => ({
              run_id: msg.run_id,
              external_id: p.external_id,
              source: msg.source,
              title: p.title,
              abstract: p.abstract,
              url: p.url,
              published_at: p.published_at,
              coarse_score: coarseScore(msg.summary, `${p.title} ${p.abstract ?? ''}`),
            })),
          )
          .onConflict((oc) => oc.columns(['run_id', 'external_id']).doNothing())
          .compile(),
      );
    }
  }

  await batch(env.DB, statements);

  if (failure) throw new Error(failure);
}
