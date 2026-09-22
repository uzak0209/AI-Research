import { surveyTrend, surveyTrendFromPapers } from './application/survey';
import type { FetchedPaper } from '../shared/papers/domain';
import type { TrendDeps } from './application/ports';
import { openAlexPaperSource, orcaTrendLlm } from './infrastructure/adapters';
import type { OrcaClassPolicy } from '../shared/orca/policy';

export const TREND_ENDPOINT = '/bff/trends';

export function createTrendApp(opts: {
  orcaKey: string;
  openAlexKey?: string;
  policy: OrcaClassPolicy;
}): TrendDeps & {
  survey(topic: string): ReturnType<typeof surveyTrend>;
  surveyPapers(topic: string, papers: FetchedPaper[]): ReturnType<typeof surveyTrendFromPapers>;
} {
  const deps: TrendDeps = {
    papers: openAlexPaperSource(opts.openAlexKey),
    llm: orcaTrendLlm(opts.orcaKey, opts.policy),
  };
  return {
    ...deps,
    survey: (topic) => surveyTrend(deps, topic),
    surveyPapers: (topic, papers) => surveyTrendFromPapers(deps, topic, papers),
  };
}
