export interface FetchedPaper {
  external_id: string;
  title: string;
  authors: string | null;
  abstract: string | null;
  url: string | null;
  published_at: string | null;
}

/** ライブラリ・引用キーと同じ「姓 名; 姓 名」。長すぎるときは切る（書誌スキーマ 500） */
const AUTHORS_MAX = 500;

export function formatAuthors(names: string[]): string | null {
  const cleaned = names.map((n) => n.trim()).filter(Boolean);
  if (cleaned.length === 0) return null;
  const joined = cleaned.join('; ');
  return joined.length > AUTHORS_MAX ? joined.slice(0, AUTHORS_MAX) : joined;
}

/** OpenAlex authorships。display_name を優先し、無ければ raw_author_name */
export function authorsFromAuthorships(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  const names: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { author?: { display_name?: unknown }; raw_author_name?: unknown };
    const fromAuthor = typeof row.author?.display_name === 'string' ? row.author.display_name : '';
    const fromRaw = typeof row.raw_author_name === 'string' ? row.raw_author_name : '';
    const name = fromAuthor.trim() || fromRaw.trim();
    if (name) names.push(name);
  }
  return formatAuthors(names);
}

export function yearFromPublishedAt(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const y = Number(String(raw).slice(0, 4));
  return Number.isInteger(y) && y >= 1000 && y <= 2100 ? y : null;
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
