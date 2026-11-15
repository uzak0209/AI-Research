import type { CollectMessage, Env } from '../env';
import { ingestCollect } from './application/ingest';
import { scheduleCollect } from './application/schedule';
import { ingestDeps, scheduleDeps } from './infrastructure/adapters';

export async function handleScheduled(env: Env): Promise<void> {
  return scheduleCollect(scheduleDeps(env));
}

export async function handleQueueMessage(msg: CollectMessage, env: Env, final = true): Promise<void> {
  return ingestCollect(ingestDeps(env), msg, final);
}

export { SOURCES, coarseScore } from './domain';
