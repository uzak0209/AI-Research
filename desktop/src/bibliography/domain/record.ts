export type BibliographicRecord = {
  title: string | null;
  authors: string | null;
  year: number | null;
  doi: string | null;
  url: string | null;
  venue: string | null;
  abstract: string | null;
  item_type: string;
};

export type BibliographyHint = {
  title?: string;
  authors?: string;
  year?: number;
  doi?: string;
  url?: string;
  venue?: string;
  abstract?: string;
  first_page?: string;
};

export type ReferenceSnapshot = {
  reference_id: string;
  title: string;
  authors: string | null;
  year: number | null;
  doi: string | null;
  url: string | null;
  venue: string | null;
  abstract: string | null;
  item_type: string;
  bibtex_key: string;
};

export function isEmptyRecord(r: BibliographicRecord | null | undefined): boolean {
  // 公開文献に著者が無い補完は成功と偽らない（C-07）
  return !r || (!r.title && !r.doi) || !r.authors?.trim();
}

/** 取れた項目だけ上書き。空で既存を消さない */
export function mergeRecord(current: ReferenceSnapshot, incoming: BibliographicRecord): Partial<ReferenceSnapshot> {
  return {
    title: incoming.title ?? current.title,
    authors: incoming.authors ?? current.authors,
    year: incoming.year ?? current.year,
    doi: incoming.doi ?? current.doi,
    url: incoming.url ?? current.url,
    venue: incoming.venue ?? current.venue,
    abstract: incoming.abstract ?? current.abstract,
    item_type: incoming.item_type || current.item_type,
  };
}

export function hintFromReference(r: {
  title: string;
  authors?: string | null;
  year?: number | null;
  doi?: string | null;
  url?: string | null;
  venue?: string | null;
  abstract?: string | null;
  first_page?: string | null;
}): BibliographyHint {
  const hint: BibliographyHint = {};
  if (r.title.trim()) hint.title = r.title.trim();
  if (r.authors?.trim()) hint.authors = r.authors.trim();
  if (r.year) hint.year = r.year;
  if (r.doi?.trim()) hint.doi = r.doi.trim();
  if (r.url?.trim()) hint.url = r.url.trim();
  if (r.venue?.trim()) hint.venue = r.venue.trim();
  if (r.abstract?.trim()) hint.abstract = r.abstract.trim();
  if (r.first_page?.trim()) hint.first_page = r.first_page.trim().slice(0, 4000);
  return hint;
}
