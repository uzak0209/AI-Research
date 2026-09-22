import { parseTrendReport, toTrendPapers, type TrendPaper } from '../domain';
import type { FetchedPaper } from '../../shared/papers/domain';
import type { TrendDeps } from './ports';

export type SurveyOk = {
  ok: true;
  papers: TrendPaper[];
  summary: string | null;
  themes: string[];
  model: string | null;
  requestedModel: string | null;
  tokens: number;
  costUsd: number | null;
  latencyMs: number;
  fallbackUsed: boolean;
};
export type SurveyFail = { ok: false; status: 502; detail: string };

function emptyOk(): SurveyOk {
  return {
    ok: true,
    papers: [],
    summary: null,
    themes: [],
    model: null,
    requestedModel: null,
    tokens: 0,
    costUsd: null,
    latencyMs: 0,
    fallbackUsed: false,
  };
}

export async function surveyTrend(deps: TrendDeps, topic: string): Promise<SurveyOk | SurveyFail> {
  let papers;
  try {
    papers = await deps.papers.fetch(topic);
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'openalex';
    return { ok: false, status: 502, detail };
  }
  return surveyTrendFromPapers(deps, topic, papers);
}

/** 既に持っている公開論文だけを材料にする。OpenAlex を取り直さない */
export async function surveyTrendFromPapers(
  deps: Pick<TrendDeps, 'llm'>,
  topic: string,
  papers: FetchedPaper[],
): Promise<SurveyOk | SurveyFail> {
  if (papers.length === 0) return emptyOk();

  const llm = await deps.llm.summarize(topic, papers);
  if (!llm.ok) return { ok: false, status: 502, detail: 'orcarouter' };

  const parsed = parseTrendReport(llm.summary);
  return {
    ok: true,
    papers: toTrendPapers(papers),
    summary: parsed.trend,
    themes: parsed.themes,
    model: llm.model,
    requestedModel: llm.requestedModel,
    tokens: llm.tokens,
    costUsd: llm.costUsd,
    latencyMs: llm.latencyMs,
    fallbackUsed: llm.fallbackUsed,
  };
}
