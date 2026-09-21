import type { Env } from '../env';
import { dailyCallLimit } from './domain';
import type { UsageStore } from './application/ports';
import { d1UsageStore } from './infrastructure/d1';

export function createUsage(env: Env): UsageStore & { limit: number } {
  const store = d1UsageStore(env.DB);
  return {
    ...store,
    limit: dailyCallLimit(env.LLM_DAILY_CALL_LIMIT),
  };
}

export { dailyCallLimit } from './domain';
export type { Classification } from './domain';
export type { UsageStore } from './application/ports';
