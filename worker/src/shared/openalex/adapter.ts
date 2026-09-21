import { z } from 'zod';
import {
  authorsFromAuthorships,
  doiOrNull,
  publicWorkUrl,
  rebuildAbstract,
  type FetchedPaper,
} from '../papers/domain';

export type OpenAlexOpts = {
  apiKey?: string;
  page?: number;
  skipIds?: Iterable<string>;
  take?: number;
  maxPages?: number;
};

/** 1 回の収集で新規として残す件数 */
export const OPENALEX_PER_PAGE = 25;
/** 先頭（新しい順）から既知を飛ばして次を見る上限 */
export const OPENALEX_MAX_PAGES = 8;
/** これより古いものは「最新」の対象にしない */
export const COLLECT_RECENT_YEARS = 3;

/** UTC で直近 N 年の 1 月 1 日。夏時間に依存させない */
export function collectFromPublicationDate(now = new Date()): string {
  return `${now.getUTCFullYear() - COLLECT_RECENT_YEARS}-01-01`;
}

const openAlexWorkSchema = z.object({
  id: z.string(),
  doi: z.string().nullable().optional(),
  display_name: z.string().nullable().optional(),
  publication_date: z.string().nullable().optional(),
  authorships: z.array(z.unknown()).nullable().optional(),
  abstract_inverted_index: z.record(z.string(), z.array(z.number())).nullable().optional(),
});

const openAlexResponseSchema = z.object({
  results: z.array(z.unknown()).optional(),
});

/**
 * 2026-02 以降、共有 IP（Workers）からの無鍵呼び出しはデモ枠で落ちる。
 * 識別は `api_key`。URL をログに出さない（C-06）。
 */
export function openAlexWorksUrl(query: string, opts: OpenAlexOpts = {}): URL {
  const q = query.split(/\s+/).slice(0, 24).join(' ');
  const url = new URL('https://api.openalex.org/works');
  url.searchParams.set('search', q);
  url.searchParams.set(
    'filter',
    `has_abstract:true,type:article,from_publication_date:${collectFromPublicationDate()}`,
  );
  url.searchParams.set('per-page', String(OPENALEX_PER_PAGE));
  url.searchParams.set('sort', 'publication_date:desc');
  url.searchParams.set(
    'select',
    'id,doi,display_name,publication_date,authorships,abstract_inverted_index',
  );
  if (opts.page && opts.page > 1) url.searchParams.set('page', String(opts.page));
  if (opts.apiKey) url.searchParams.set('api_key', opts.apiKey);
  return url;
}

function mapWork(raw: unknown): FetchedPaper | null {
  const work = openAlexWorkSchema.safeParse(raw);
  if (!work.success) return null;
  const w = work.data;
  const title = w.display_name?.trim() ?? '';
  if (!title) return null;
  const doi = doiOrNull(w.doi);
  return {
    external_id: doi ?? w.id,
    title,
    authors: authorsFromAuthorships(w.authorships),
    abstract: rebuildAbstract(w.abstract_inverted_index),
    url: publicWorkUrl({ doi: w.doi, id: w.id }),
    published_at: w.publication_date ?? null,
  };
}

async function fetchOpenAlexPage(
  query: string,
  opts: OpenAlexOpts,
): Promise<{ papers: FetchedPaper[]; rawCount: number }> {
  const res = await fetch(openAlexWorksUrl(query, opts), {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`openalex status=${res.status}`);

  const parsed = openAlexResponseSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error('openalex response invalid');

  const raw = parsed.data.results ?? [];
  const papers: FetchedPaper[] = [];
  for (const row of raw) {
    const p = mapWork(row);
    if (p) papers.push(p);
  }
  return { papers, rawCount: raw.length };
}

/**
 * ソースアダプタ。公開 API のみを叩く。
 * 粗い採点は文字列一致の水準に留める（重い判定はローカル。ADR-0004）
 *
 * 公開日の新しい順。既に持っている ID は飛ばし、ページ 1 に後から載った最新を拾う。
 */
export async function fetchFromSource(
  source: string,
  summary: string,
  opts: OpenAlexOpts = {},
): Promise<FetchedPaper[]> {
  if (source !== 'openalex') throw new Error(`未知のソース: ${source}`);

  const take = opts.take ?? OPENALEX_PER_PAGE;
  const maxPages = opts.maxPages ?? OPENALEX_MAX_PAGES;
  const skip = new Set(opts.skipIds ?? []);
  const papers: FetchedPaper[] = [];

  for (let page = 1; page <= maxPages && papers.length < take; page++) {
    const batch = await fetchOpenAlexPage(summary, { ...opts, page });
    for (const p of batch.papers) {
      if (skip.has(p.external_id)) continue;
      papers.push(p);
      if (papers.length >= take) break;
    }
    if (batch.rawCount < OPENALEX_PER_PAGE) break;
  }

  return papers;
}
