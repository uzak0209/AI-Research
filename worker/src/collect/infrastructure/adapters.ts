import { sql } from 'kysely';
import type { CollectMessage, Env } from '../../env';
import { utcDate } from '../../shared/date';
import { batch, execute } from '../../db/execute';
import { db } from '../../db/kysely';
import { fetchFromSource } from '../../shared/openalex/adapter';
import { createUsage } from '../../usage';
import { attachProblemExcerpts, REVIEW_ENDPOINT } from '../application/problem-excerpt';
import { COLLECT_ENDPOINT, buildSearchQuery } from '../application/search-terms';
import type { OrcaChatOk } from '../../shared/orca/chat';
import type {
  CollectClock,
  CollectIdempotency,
  CollectQueue,
  IngestDeps,
  PaperFetcher,
  ProjectList,
  RunStore,
  ScheduleDeps,
} from '../application/ports';
import type { ScoredPaper } from '../domain';

/** D1 の 1 文あたりのバインド変数の上限 */
const D1_MAX_BIND_PARAMS = 100;
/** run_papers に 1 行あたり入れる列数 */
const RUN_PAPER_COLUMNS = 10;

export function kvIdempotency(kv: KVNamespace): CollectIdempotency {
  return {
    get: (key) => kv.get(key),
    put: (key, value, ttlSec) => kv.put(key, value, { expirationTtl: ttlSec }),
  };
}

export function d1Projects(d1: D1Database): ProjectList {
  return {
    list: () =>
      execute<{ project_id: string; summary: string; user_id: string }>(
        d1,
        db.selectFrom('projects').select(['project_id', 'summary', 'user_id']).compile(),
      ),
  };
}

export function queueCollect(queue: Queue<CollectMessage>): CollectQueue {
  return {
    sendBatch: async (messages) => {
      await queue.sendBatch(messages);
    },
  };
}

export function utcClock(): CollectClock {
  return { today: () => utcDate() };
}

export function openAlexFetcher(apiKey?: string): PaperFetcher {
  return {
    fetch: (source, summary) => fetchFromSource(source, summary, { apiKey }),
  };
}

export function d1Runs(d1: D1Database): RunStore {
  return {
    async save(msg, papers: ScoredPaper[], failure) {
      const status = failure ? 'failed' : papers.length === 0 ? 'empty' : 'ok';
      const failedJson = failure ? JSON.stringify([{ source: msg.source, error: failure }]) : null;

      const statements = [
        sql`
          INSERT INTO runs (run_id, project_id, run_date, status, failed_sources_json)
          VALUES (${msg.run_id}, ${msg.project_id}, ${msg.run_date}, ${status}, ${failedJson})
          ON CONFLICT (run_id) DO UPDATE SET
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
                  authors: p.authors,
                  abstract: p.abstract,
                  url: p.url,
                  published_at: p.published_at,
                  coarse_score: p.coarse_score,
                  problem_excerpt: p.problem_excerpt,
                })),
              )
              .onConflict((oc) => oc.columns(['run_id', 'external_id']).doNothing())
              .compile(),
          );
        }
      }

      await batch(d1, statements);
    },
  };
}

export function scheduleDeps(env: Env): ScheduleDeps {
  return {
    clock: utcClock(),
    idempotency: kvIdempotency(env.IDEMPOTENCY),
    projects: d1Projects(env.DB),
    queue: queueCollect(env.COLLECT_QUEUE),
  };
}

export function ingestDeps(env: Env): IngestDeps {
  return {
    papers: openAlexFetcher(env.OPENALEX_API_KEY),
    runs: d1Runs(env.DB),
    search: {
      build: (summary) => buildSearchQuery(env, summary),
    },
    problemExcerpt: {
      attach: (papers) => attachProblemExcerpts(env, papers),
    },
    usage: {
      async recordSearch(msg, usage) {
        await recordCollectLlm(env, msg, COLLECT_ENDPOINT, usage);
      },
      async recordReview(msg, usage) {
        await recordCollectLlm(env, msg, REVIEW_ENDPOINT, usage);
      },
    },
  };
}

async function recordCollectLlm(
  env: Env,
  msg: CollectMessage,
  endpoint: string,
  usage: OrcaChatOk,
): Promise<void> {
  const userId = msg.user_id ?? (await projectUserId(env.DB, msg.project_id));
  if (!userId) return;
  await createUsage(env).record({
    userId,
    endpoint,
    classification: 'C1',
    requestedModel: usage.requestedModel,
    resolvedModel: usage.model,
    tokens: usage.tokens,
    costUsd: usage.costUsd,
    latencyMs: usage.latencyMs,
    fallbackUsed: usage.fallbackUsed,
  });
}

/** 配送中の古いメッセージに user_id が無いときだけ引く */
async function projectUserId(d1: D1Database, projectId: string): Promise<string | null> {
  const rows = await execute<{ user_id: string }>(
    d1,
    db.selectFrom('projects').select('user_id').where('project_id', '=', projectId).compile(),
  );
  return rows[0]?.user_id ?? null;
}
