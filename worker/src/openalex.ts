import { openAlexResponseSchema, openAlexWorkSchema } from './schema';

export interface FetchedPaper {
  external_id: string;
  title: string;
  abstract: string | null;
  url: string | null;
  published_at: string | null;
}

export type OpenAlexOpts = { apiKey?: string };

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
 * 2026-02 以降、共有 IP（Workers）からの無鍵呼び出しはデモ枠で落ちる。
 * 識別は `api_key`。URL をログに出さない（C-06）。
 */
export function openAlexWorksUrl(query: string, opts: OpenAlexOpts = {}): URL {
  const q = query.split(/\s+/).slice(0, 24).join(' ');
  const url = new URL('https://api.openalex.org/works');
  url.searchParams.set('search', q);
  url.searchParams.set('filter', 'has_abstract:true,type:article');
  url.searchParams.set('per-page', '25');
  url.searchParams.set('sort', 'publication_date:desc');
  url.searchParams.set('select', 'id,doi,display_name,publication_date,abstract_inverted_index');
  if (opts.apiKey) url.searchParams.set('api_key', opts.apiKey);
  return url;
}

/**
 * ソースアダプタ。公開 API のみを叩く。
 * 粗い採点は文字列一致の水準に留める（重い判定はローカル。ADR-0004）
 */
export async function fetchFromSource(
  source: string,
  summary: string,
  opts: OpenAlexOpts = {},
): Promise<FetchedPaper[]> {
  if (source !== 'openalex') throw new Error(`未知のソース: ${source}`);

  const res = await fetch(openAlexWorksUrl(summary, opts), {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`openalex status=${res.status}`);

  const parsed = openAlexResponseSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error('openalex response invalid');

  const papers: FetchedPaper[] = [];
  for (const raw of parsed.data.results ?? []) {
    const work = openAlexWorkSchema.safeParse(raw);
    if (!work.success) continue;
    const w = work.data;
    papers.push({
      external_id: w.doi ?? w.id,
      title: w.display_name ?? '',
      abstract: rebuildAbstract(w.abstract_inverted_index),
      url: w.doi ?? w.id ?? null,
      published_at: w.publication_date ?? null,
    });
  }
  return papers;
}
