import type { CollectMessage } from '../../env';
import type { FetchedPaper } from '../../shared/papers/domain';
import type { ScoredPaper } from '../domain';

export type ProjectList = {
  list(): Promise<{ project_id: string; summary: string }[]>;
};

export type CollectIdempotency = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSec: number): Promise<void>;
};

export type CollectQueue = {
  sendBatch(messages: { body: CollectMessage }[]): Promise<void>;
};

export type CollectClock = {
  today(): string;
};

export type ScheduleDeps = {
  clock: CollectClock;
  idempotency: CollectIdempotency;
  projects: ProjectList;
  queue: CollectQueue;
};

export type PaperFetcher = {
  fetch(source: string, summary: string): Promise<FetchedPaper[]>;
};

export type RunStore = {
  save(msg: CollectMessage, papers: ScoredPaper[], failure: string | null): Promise<void>;
};

export type IngestDeps = {
  papers: PaperFetcher;
  runs: RunStore;
};
