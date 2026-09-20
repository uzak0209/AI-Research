import { openAlexResponseSchema } from './schema';

export interface FetchedPaper {
  external_id: string;
  title: string;
  abstract: string | null;
  url: string | null;
  published_at: string | null;
}

/** OpenAlex の要旨は転置インデックスなので語順を戻す */
export function rebuildAbstract(ii: Record<string, number[]> | null | undefined): string | null {
  if (!ii) return null;
  const slots: string[] = [];
  for (const [word, positions] of Object.entries(ii)) {
    for (const p of positions) slots[p] = word;
  }
  const text = slots.filter(Boolean).join(' ').trim();
  return text || null;
}

/**
 * ソースアダプタ。公開 API のみを叩く。
 * 粗い採点は文字列一致の水準に留める（重い判定はローカル。ADR-0004）
 */
export async function fetchFromSource(source: string, summary: string): Promise<FetchedPaper[]> {
  if (source !== 'openalex') throw new Error(`未知のソース: ${source}`);

  const q = summary.split(/\s+/).slice(0, 24).join(' ');
  const params = new URLSearchParams({
    filter: `title_and_abstract.search:${q},has_abstract:true,type:article`,
    'per-page': '25',
    sort: 'publication_date:desc',
  });

  const res = await fetch(`https://api.openalex.org/works?${params}`, {
    headers: { 'user-agent': 'ai-research (+https://github.com/uzak0209/AI-Research)' },
  });
  if (!res.ok) throw new Error(`openalex status=${res.status}`);

  const parsed = openAlexResponseSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error('openalex response invalid');

  return (parsed.data.results ?? []).map((w) => ({
    external_id: w.doi ?? w.id,
    title: w.display_name ?? '',
    abstract: rebuildAbstract(w.abstract_inverted_index),
    url: w.doi ?? w.id ?? null,
    published_at: w.publication_date ?? null,
  }));
}
