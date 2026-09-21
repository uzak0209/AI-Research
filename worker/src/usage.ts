import { sql } from 'kysely';
import { utcDate } from './date';
import { db } from './db/kysely';
import { execute } from './db/execute';
import type { Env } from './env';

export type Classification = 'C1' | 'C2' | 'C3';

/** 設定が壊れていたら 0 = 全部止める（fail closed。NFR-04） */
export function dailyCallLimit(env: Env): number {
  const n = Number.parseInt(env.LLM_DAILY_CALL_LIMIT, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** JWT sub = oauth_subject。IdP 未決の間は sub を user_id にも使う */
export async function ensureUserId(d1: D1Database, oauthSubject: string): Promise<string> {
  const found = await execute<{ user_id: string }>(
    d1,
    db.selectFrom('users').select('user_id').where('oauth_subject', '=', oauthSubject).compile(),
  );
  if (found[0]) return found[0].user_id;

  await execute(
    d1,
    db
      .insertInto('users')
      .values({
        user_id: oauthSubject,
        oauth_subject: oauthSubject,
        created_at: new Date().toISOString(),
      })
      .onConflict((oc) => oc.column('oauth_subject').doNothing())
      .compile(),
  );

  const again = await execute<{ user_id: string }>(
    d1,
    db.selectFrom('users').select('user_id').where('oauth_subject', '=', oauthSubject).compile(),
  );
  if (!again[0]) throw new Error('user resolve failed');
  return again[0].user_id;
}

export async function dailyCallCount(d1: D1Database, userId: string, day = utcDate()): Promise<number> {
  const rows = await execute<{ calls: number | string | null }>(
    d1,
    db
      .selectFrom('llm_usage')
      .select(sql<number | string | null>`coalesce(sum(calls), 0)`.as('calls'))
      .where('user_id', '=', userId)
      .where('usage_date', '=', day)
      .compile(),
  );
  return Number(rows[0]?.calls ?? 0);
}

/**
 * 監査に本文を残さない。宛先・分類・数量だけ（ADR-0002）。
 *
 * 宛先ごとに比べられるよう、要求した宛先（model）と応答したモデル（resolved_model）で
 * 行を分ける。推論時間とコストは**合計**で積む。この行は upsert で積み上がる集計なので、
 * 1 回分の値を置くと最後の呼び出しで上書きされる。平均は latency_ms_sum / calls で出す。
 */
export async function recordLlmUsage(
  d1: D1Database,
  row: {
    userId: string;
    endpoint: string;
    classification: Classification;
    /** 要求した宛先。Named Router 名またはモデル ID */
    requestedModel: string | null;
    /** 実際に応答したモデル */
    resolvedModel: string | null;
    tokens: number;
    /** 取れなかったときは null。0 として足さない（C-07） */
    costUsd?: number | null;
    latencyMs?: number;
    fallbackUsed?: boolean;
  },
): Promise<void> {
  const day = utcDate();
  const requested = row.requestedModel ?? '';
  const resolved = row.resolvedModel ?? '';
  const cost = row.costUsd ?? 0;
  const latency = row.latencyMs ?? 0;
  const fallback = row.fallbackUsed ? 1 : 0;

  await execute(
    d1,
    db
      .insertInto('llm_usage')
      .values({
        user_id: row.userId,
        usage_date: day,
        endpoint: row.endpoint,
        classification: row.classification,
        model: requested,
        resolved_model: resolved,
        calls: 1,
        tokens: row.tokens,
        cost_usd: cost,
        latency_ms_sum: latency,
        fallback_calls: fallback,
      })
      .onConflict((oc) =>
        oc
          .columns(['user_id', 'usage_date', 'endpoint', 'model', 'resolved_model'])
          .doUpdateSet({
            calls: sql`calls + 1`,
            tokens: sql`tokens + ${row.tokens}`,
            cost_usd: sql`cost_usd + ${cost}`,
            latency_ms_sum: sql`latency_ms_sum + ${latency}`,
            fallback_calls: sql`fallback_calls + ${fallback}`,
            classification: row.classification,
          }),
      )
      .compile(),
  );
}
