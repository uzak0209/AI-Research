import type { FetchedPaper } from '../../shared/papers/domain';

export type PaperSource = {
  fetch(topic: string): Promise<FetchedPaper[]>;
};

export type TrendLlm = {
  summarize(topic: string, papers: FetchedPaper[]): Promise<
    { ok: true; summary: string; model: string; tokens: number } | { ok: false }
  >;
};

export type TrendDeps = {
  papers: PaperSource;
  llm: TrendLlm;
};
