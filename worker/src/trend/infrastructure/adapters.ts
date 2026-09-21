import type { FetchedPaper } from '../../shared/papers/domain';
import { fetchFromSource } from '../../shared/openalex/adapter';
import { chatCompletion } from '../../shared/orca/chat';
import { ORCA_POLICY } from '../../shared/orca/policy';
import { trendPrompt } from '../domain';
import type { PaperSource, TrendLlm } from '../application/ports';

export function openAlexPaperSource(apiKey?: string): PaperSource {
  return {
    fetch: (topic) => fetchFromSource('openalex', topic, { apiKey }),
  };
}

export function orcaTrendLlm(apiKey: string): TrendLlm {
  return {
    async summarize(topic: string, papers: FetchedPaper[]) {
      const result = await chatCompletion(
        apiKey,
        [
          {
            role: 'system',
            content: 'You summarize public research trends. Never claim a paper that is not in the user list.',
          },
          { role: 'user', content: trendPrompt(topic, papers) },
        ],
        ORCA_POLICY.C1,
      );
      if (!result.ok) return { ok: false };
      return { ok: true, summary: result.text, model: result.model, tokens: result.tokens };
    },
  };
}
