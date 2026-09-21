export interface FetchedPaper {
  external_id: string;
  title: string;
  abstract: string | null;
  url: string | null;
  published_at: string | null;
}

export function normalizeDoi(raw: string): string {
  return raw.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim();
}

export function doiOrNull(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = normalizeDoi(raw);
  return /^10\.\d{4,}/.test(d) ? d : null;
}

/** desktop の `papers.url` に入る値。DOI 生文字列や OpenAlex ID を URL のふりをしない */
export function publicWorkUrl(opts: {
  doi?: string | null;
  landing?: string | null;
  id?: string | null;
}): string | null {
  if (opts.landing && /^https?:\/\//i.test(opts.landing)) return opts.landing;
  const doi = doiOrNull(opts.doi ?? null);
  if (doi) return `https://doi.org/${doi}`;
  if (opts.id && /^https?:\/\//i.test(opts.id)) return opts.id;
  return null;
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
