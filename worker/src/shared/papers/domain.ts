export interface FetchedPaper {
  external_id: string;
  title: string;
  authors: string | null;
  abstract: string | null;
  url: string | null;
  published_at: string | null;
  /** OA の直 PDF（https のみ）。無ければ null = 未取得（C-07） */
  pdf_url?: string | null;
}

/** https の直 PDF だけ。HTML ランディングと http は捨てる（ADR-0003） */
export function httpsPdfUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const u = raw.trim();
  if (!/^https:\/\//i.test(u)) return null;
  if (/\.html?(?:[?#]|$)/i.test(u)) return null;
  if (u.length > 2000) return null;
  return u;
}

/** 全文が確実に取れる置き場を先に見る。arXiv を優先する（ADR-0003） */
const PDF_HOST_PRIORITY = [
  /(^|\.)arxiv\.org$/i,
  /(^|\.)export\.arxiv\.org$/i,
  /(^|\.)biorxiv\.org$/i,
  /(^|\.)medrxiv\.org$/i,
  /(^|\.)openreview\.net$/i,
  /(^|\.)ncbi\.nlm\.nih\.gov$/i,
  /(^|\.)hal\.science$/i,
];

/** 本文ではないもの。参考文献一覧だけの PDF と、PDF に見えない DOI ランディング */
function isWeakPdfUrl(url: string, host: string): boolean {
  if (/_reference\.pdf(?:[?#]|$)/i.test(url)) return true;
  return /(^|\.)doi\.org$/i.test(host);
}

function pdfHostRank(url: string): number {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return PDF_HOST_PRIORITY.length + 1;
  }
  if (isWeakPdfUrl(url, host)) return PDF_HOST_PRIORITY.length + 1;
  const hit = PDF_HOST_PRIORITY.findIndex((re) => re.test(host));
  return hit === -1 ? PDF_HOST_PRIORITY.length : hit;
}

/**
 * OpenAlex の location 群から OA の直 PDF を選ぶ。
 * arXiv などの全文リポジトリを優先する。出版社の購読ページは直 PDF が無いので落ちる。
 */
export function pickOaPdfUrl(candidates: (string | null | undefined)[]): string | null {
  const urls: string[] = [];
  for (const raw of candidates) {
    const u = httpsPdfUrl(raw);
    if (u && !urls.includes(u)) urls.push(u);
  }
  if (urls.length === 0) return null;
  let best = urls[0]!;
  let bestRank = pdfHostRank(best);
  for (const u of urls.slice(1)) {
    const rank = pdfHostRank(u);
    if (rank < bestRank) {
      best = u;
      bestRank = rank;
    }
  }
  return best;
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
