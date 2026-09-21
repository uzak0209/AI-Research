import { toTrendPapers, type TrendPaper } from '../domain';
import type { TrendDeps } from './ports';

export type SurveyOk = {
  ok: true;
  papers: TrendPaper[];
  summary: string | null;
  model: string | null;
  requestedModel: string | null;
  tokens: number;
  costUsd: number | null;
  latencyMs: number;
  fallbackUsed: boolean;
};
export type SurveyFail = { ok: false; status: 502; detail: string };

export async function surveyTrend(deps: TrendDeps, topic: string): Promise<SurveyOk | SurveyFail> {
  let papers;
  try {
    papers = await deps.papers.fetch(topic);
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'openalex';
    return { ok: false, status: 502, detail };
  }

  if (papers.length === 0) {
    return {
      ok: true,
      papers: [],
      summary: null,
      model: null,
      requestedModel: null,
      tokens: 0,
      costUsd: null,
      latencyMs: 0,
      fallbackUsed: false,
    };
  }

  const llm = await deps.llm.summarize(topic, papers);
  if (!llm.ok) return { ok: false, status: 502, detail: 'orcarouter' };

  return {
    ok: true,
    papers: toTrendPapers(papers),
    summary: llm.summary,
    model: llm.model,
    requestedModel: llm.requestedModel,
    tokens: llm.tokens,
    costUsd: llm.costUsd,
    latencyMs: llm.latencyMs,
    fallbackUsed: llm.fallbackUsed,
  };
}
