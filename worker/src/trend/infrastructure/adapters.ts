import type { FetchedPaper } from '../../shared/papers/domain';
import { fetchFromSource } from '../../shared/openalex/adapter';
import { chatCompletion } from '../../shared/orca/chat';
import type { OrcaClassPolicy } from '../../shared/orca/policy';
import { trendPrompt } from '../domain';
import type { PaperSource, TrendLlm } from '../application/ports';

export function openAlexPaperSource(apiKey?: string): PaperSource {
  return {
    fetch: (topic) => fetchFromSource('openalex', topic, { apiKey }),
  };
}

export function orcaTrendLlm(apiKey: string, policy: OrcaClassPolicy): TrendLlm {
  return {
    async summarize(topic: string, papers: FetchedPaper[]) {
      const result = await chatCompletion(
        apiKey,
        [
          {
            role: 'system',
            content:
              'You summarize public research trends from the listed papers only. Reply with JSON: {"trend": string, "themes": string[]}. Never claim a paper that is not in the user list.',
          },
          { role: 'user', content: trendPrompt(topic, papers) },
        ],
        policy,
        // JSON を強制する。地の文で返されると本文が丸ごと trend に落ちる
        true,
      );
      if (!result.ok) return { ok: false };
      return {
        ok: true,
        summary: result.text,
        model: result.model,
        requestedModel: result.requestedModel,
        tokens: result.tokens,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        costUsd: result.costUsd,
        latencyMs: result.latencyMs,
        fallbackUsed: result.fallbackUsed,
      };
    },
  };
}
