import type { FetchedPaper } from '../../shared/papers/domain';

export type PaperSource = {
  fetch(topic: string): Promise<FetchedPaper[]>;
};

export type TrendLlmOk = {
  ok: true;
  summary: string;
  model: string;
  requestedModel: string;
  tokens: number;
  costUsd: number | null;
  latencyMs: number;
  fallbackUsed: boolean;
};

export type TrendLlm = {
  summarize(topic: string, papers: FetchedPaper[]): Promise<TrendLlmOk | { ok: false }>;
};

export type TrendDeps = {
  papers: PaperSource;
  llm: TrendLlm;
};
