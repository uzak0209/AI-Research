import type { FetchedPaper } from './openalex';
import { fetchFromSource } from './openalex';
import { C1_MODEL, chatCompletion } from './orca';

export const TREND_ENDPOINT = '/bff/trends';
export const TREND_PAPER_LIMIT = 12;
const ABSTRACT_CHARS = 400;

export type TrendPaper = {
  title: string;
  url: string | null;
  published_at: string | null;
};

/**
 * 公開論文の題・要旨・URL・日付だけを載せる。
 * 原稿や手元データは渡さない（C-01, C-09）。
 */
export function trendPrompt(topic: string, papers: FetchedPaper[]): string {
  const listed = papers.slice(0, TREND_PAPER_LIMIT).map((p, i) => {
    const abs = (p.abstract ?? '').slice(0, ABSTRACT_CHARS);
    const when = p.published_at ?? 'n.d.';
    const url = p.url ?? '';
    return `${i + 1}. ${p.title} (${when}) ${url}\n${abs}`.trim();
  });
  return [
    `Topic: ${topic}`,
    'Summarize research trends using ONLY the public papers below.',
    'Do not invent papers, citations, or results that are not in the list.',
    'If the list is thin, say so. Reply in the same language as the topic.',
    listed.join('\n\n'),
  ].join('\n\n');
}

export function toTrendPapers(papers: FetchedPaper[]): TrendPaper[] {
  return papers.slice(0, TREND_PAPER_LIMIT).map((p) => ({
    title: p.title,
    url: p.url,
    published_at: p.published_at,
  }));
}

export async function fetchPublicPapers(topic: string): Promise<FetchedPaper[]> {
  return fetchFromSource('openalex', topic);
}

export async function summarizeTrend(
  apiKey: string,
  topic: string,
  papers: FetchedPaper[],
): Promise<{ ok: true; summary: string; model: string; tokens: number } | { ok: false; status: number }> {
  const result = await chatCompletion(apiKey, [
    {
      role: 'system',
      content: 'You summarize public research trends. Never claim a paper that is not in the user list.',
    },
    { role: 'user', content: trendPrompt(topic, papers) },
  ], C1_MODEL);

  if (!result.ok) return result;
  return { ok: true, summary: result.text, model: result.model, tokens: result.tokens };
}
