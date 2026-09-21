import { sql } from 'kysely';
import { utcDate } from '../../shared/date';
import { db } from '../../db/kysely';
import { execute } from '../../db/execute';
import type { UsageStore } from '../application/ports';

export function d1UsageStore(d1: D1Database): UsageStore {
  return {
    async ensureUser(oauthSubject) {
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
    },

    async dailyCallCount(userId, day = utcDate()) {
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
    },

    async record(row) {
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
            oc.columns(['user_id', 'usage_date', 'endpoint', 'model', 'resolved_model']).doUpdateSet({
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
    },
  };
}
