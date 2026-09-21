import type { CollectMessage, Env } from '../env';
import { ingestCollect } from './application/ingest';
import { scheduleCollect } from './application/schedule';
import { ingestDeps, scheduleDeps } from './infrastructure/adapters';

export async function handleScheduled(env: Env): Promise<void> {
  return scheduleCollect(scheduleDeps(env));
}

export async function handleQueueMessage(msg: CollectMessage, env: Env): Promise<void> {
  return ingestCollect(ingestDeps(env), msg);
}

export { SOURCES, coarseScore } from './domain';
