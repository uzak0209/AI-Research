import { sql } from 'kysely';
import type { CollectMessage, Env } from '../../env';
import { utcDate } from '../../shared/date';
import { batch, execute } from '../../db/execute';
import { db } from '../../db/kysely';
import { fetchFromSource } from '../../shared/openalex/adapter';
import { createUsage, type CallStage } from '../../usage';
import { attachProblemExcerpts, REVIEW_ENDPOINT } from '../application/problem-excerpt';
import { COLLECT_ENDPOINT, buildSearchQuery, parseSearchTermsJson } from '../application/search-terms';
import type { OrcaChatOk } from '../../shared/orca/chat';
import { orcaKey } from '../../shared/orca/chat';
import { trendPolicy } from '../../shared/orca/policy';
import { TREND_ENDPOINT, createTrendApp } from '../../trend';
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
const RUN_PAPER_COLUMNS = 14;

export function kvIdempotency(kv: KVNamespace): CollectIdempotency {
  return {
    get: (key) => kv.get(key),
    put: (key, value, ttlSec) => kv.put(key, value, { expirationTtl: ttlSec }),
  };
}

export function d1Projects(d1: D1Database): ProjectList {
  return {
    async list() {
      const rows = await execute<{
        project_id: string;
        summary: string;
        user_id: string;
        search_terms_json: string | null;
      }>(
        d1,
        db.selectFrom('projects').select(['project_id', 'summary', 'user_id', 'search_terms_json']).compile(),
      );
      return rows.map((r) => ({
        project_id: r.project_id,
        summary: r.summary,
        user_id: r.user_id,
        search_terms: parseSearchTermsJson(r.search_terms_json),
      }));
    },
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
    fetch: (source, query, extra) =>
      fetchFromSource(source, query, {
        apiKey,
        skipIds: extra?.skipIds,
        take: extra?.take,
        maxPages: extra?.maxPages,
      }),
  };
}

export function d1Runs(d1: D1Database): RunStore {
  return {
    async knownExternalIds(projectId) {
      const rows = await execute<{ external_id: string }>(
        d1,
        sql`
          SELECT rp.external_id AS external_id
          FROM run_papers AS rp
          INNER JOIN runs AS r ON r.run_id = rp.run_id
          WHERE r.project_id = ${projectId}
        `.compile(db),
      );
      return new Set(rows.map((r) => r.external_id));
    },
    async save(msg, papers: ScoredPaper[], failure, searchTerms = [], report = { trend: null, themes: [] }) {
      const status = failure ? 'failed' : papers.length === 0 ? 'empty' : 'ok';
      const failedJson = failure ? JSON.stringify([{ source: msg.source, error: failure }]) : null;
      const termsJson = JSON.stringify(searchTerms);
      const trendSummary = report.trend;
      const themesJson = JSON.stringify(report.themes);

      const statements = [
        sql`
          INSERT INTO runs (run_id, project_id, run_date, status, failed_sources_json, search_terms_json, trend_summary, themes_json)
          VALUES (${msg.run_id}, ${msg.project_id}, ${msg.run_date}, ${status}, ${failedJson}, ${termsJson}, ${trendSummary}, ${themesJson})
          ON CONFLICT (run_id) DO UPDATE SET
            status = CASE
              WHEN runs.status = excluded.status THEN runs.status
              ELSE 'partial'
            END,
            failed_sources_json = COALESCE(excluded.failed_sources_json, runs.failed_sources_json),
            search_terms_json = excluded.search_terms_json,
            trend_summary = COALESCE(excluded.trend_summary, runs.trend_summary),
            themes_json = COALESCE(excluded.themes_json, runs.themes_json)
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
                  venue: p.venue ?? null,
                  item_type: p.item_type ?? null,
                  pdf_url: p.pdf_url ?? null,
                  coarse_score: p.coarse_score,
                  problem_excerpt: p.problem_excerpt,
                  problem_excerpt_verified:
                    p.problem_excerpt_verified === null || p.problem_excerpt_verified === undefined
                      ? null
                      : p.problem_excerpt_verified
                        ? 1
                        : 0,
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
      build: (summary, confirmed) => buildSearchQuery(env, summary, confirmed),
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
      async recordTrend(msg, usage) {
        await recordCollectLlm(env, msg, TREND_ENDPOINT, usage);
      },
    },
    trend: {
      async analyze(summary, papers) {
        const policy = trendPolicy(env);
        const apiKey = orcaKey(env, policy.slot);
        if (!apiKey || papers.length === 0) return { report: { trend: null, themes: [] }, usage: null };
        const got = await createTrendApp({
          orcaKey: apiKey,
          openAlexKey: env.OPENALEX_API_KEY,
          policy,
        }).surveyPapers(summary, papers);
        if (!got.ok) return { report: { trend: null, themes: [] }, usage: null };
        const usage: OrcaChatOk | null = got.model
          ? {
              ok: true,
              text: got.summary ?? '',
              model: got.model,
              requestedModel: got.requestedModel ?? got.model,
              tokens: got.tokens,
              tokensIn: got.tokensIn,
              tokensOut: got.tokensOut,
              costUsd: got.costUsd,
              latencyMs: got.latencyMs,
              fallbackUsed: got.fallbackUsed,
            }
          : null;
        return { report: { trend: got.summary, themes: got.themes }, usage };
      },
    },
  };
}

/** endpoint → ADR-0005 §1 の段。トレンドはレビューと同じ Named Router を使う（§2 の表） */
function stageForEndpoint(endpoint: string): CallStage {
  return endpoint === COLLECT_ENDPOINT ? '1段目' : '2段目';
}

async function recordCollectLlm(
  env: Env,
  msg: CollectMessage,
  endpoint: string,
  usage: OrcaChatOk,
): Promise<void> {
  const usageStore = createUsage(env);

  // llm_calls: run に紐付く 1 呼び出し 1 行の記録（ADR-0005 §9・§10）。userId が引けなくても残す
  await usageStore.recordCall({
    runId: msg.run_id,
    endpoint,
    classification: 'C1',
    stage: stageForEndpoint(endpoint),
    router: usage.requestedModel,
    requestedModel: usage.requestedModel,
    resolvedModel: usage.model,
    fallbackTarget: usage.fallbackUsed ? usage.model : null,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
    costUsd: usage.costUsd,
    durationMs: usage.latencyMs,
  });

  // llm_usage: 利用者単位の日次上限判定用の集計行（NFR-04）。user_id が引けなければ数えない
  const userId = msg.user_id ?? (await projectUserId(env.DB, msg.project_id));
  if (!userId) return;
  await usageStore.record({
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
