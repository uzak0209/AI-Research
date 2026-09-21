import { z } from 'zod';
import { rebuildAbstract } from './openalex';
import { JEV_POLICY } from './jev-policy';
import { parseChoice, parseNoul, systemOne, type JevQuestion } from './jev';

export const BIBLIOGRAPHY_ENDPOINT = '/bff/bibliography';
export const NONE_KEY = 'none';

const ITEM_TYPES = ['article', 'inproceedings', 'book', 'phdthesis', 'misc'] as const;

export const bibliographyHintSchema = z
  .object({
    title: z.string().trim().max(500).optional(),
    authors: z.string().trim().max(500).optional(),
    year: z.number().int().min(1000).max(2100).optional(),
    doi: z.string().trim().max(200).optional(),
    url: z.string().trim().max(2000).optional(),
    venue: z.string().trim().max(300).optional(),
    abstract: z.string().trim().max(2000).optional(),
  })
  .refine((h) => Boolean(h.title || h.doi), { message: 'title or doi required' });

export const bibliographyRecordSchema = z.object({
  title: z.string().trim().min(1).max(500).nullable(),
  authors: z.string().trim().min(1).max(500).nullable(),
  year: z.number().int().min(1000).max(2100).nullable(),
  doi: z
    .string()
    .trim()
    .nullable()
    .transform((d) => (d && /^10\.\d{4,}/.test(d) ? d : null)),
  url: z
    .string()
    .trim()
    .nullable()
    .transform((u) => (u && /^https?:\/\//i.test(u) ? u : null)),
  venue: z.string().trim().min(1).max(300).nullable(),
  abstract: z.string().trim().min(1).max(4000).nullable(),
  item_type: z
    .string()
    .nullable()
    .transform((t) => (t && (ITEM_TYPES as readonly string[]).includes(t) ? t : 'article')),
});

export type BibliographyHint = z.infer<typeof bibliographyHintSchema>;
export type BibliographyRecord = z.infer<typeof bibliographyRecordSchema>;

export type BibliographyCandidate = {
  key: string;
  title: string;
  authors: string | null;
  year: number | null;
  doi: string | null;
  url: string | null;
  venue: string | null;
  abstract: string | null;
  item_type: string;
};

const EMPTY_RECORD: BibliographyRecord = {
  title: null,
  authors: null,
  year: null,
  doi: null,
  url: null,
  venue: null,
  abstract: null,
  item_type: 'article',
};

const authorshipSchema = z.object({
  author: z.object({ display_name: z.string().optional() }).optional(),
});

const bibliographyWorkSchema = z.object({
  id: z.string(),
  doi: z.string().nullable().optional(),
  display_name: z.string().nullable().optional(),
  publication_year: z.number().int().optional().nullable(),
  publication_date: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  authorships: z.array(authorshipSchema).optional(),
  primary_location: z
    .object({
      landing_page_url: z.string().nullable().optional(),
      source: z.object({ display_name: z.string().optional() }).nullable().optional(),
    })
    .nullable()
    .optional(),
  abstract_inverted_index: z.record(z.string(), z.array(z.number())).nullable().optional(),
});

export function normalizeDoi(raw: string): string {
  return raw.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim();
}

export function itemTypeFromOpenAlex(type: string | null | undefined): string {
  switch (type) {
    case 'article':
    case 'review':
    case 'letter':
    case 'editorial':
      return 'article';
    case 'proceedings-article':
    case 'proceedings':
    case 'book-chapter':
      return 'inproceedings';
    case 'book':
    case 'monograph':
      return 'book';
    case 'dissertation':
      return 'phdthesis';
    default:
      return 'misc';
  }
}

export function yearFromWork(year: number | null | undefined, date: string | null | undefined): number | null {
  if (year && year >= 1000 && year <= 2100) return year;
  const y = date?.slice(0, 4);
  if (y && /^\d{4}$/.test(y)) {
    const n = Number(y);
    if (n >= 1000 && n <= 2100) return n;
  }
  return null;
}

export function workToCandidate(raw: unknown, index: number): BibliographyCandidate | null {
  const parsed = bibliographyWorkSchema.safeParse(raw);
  if (!parsed.success) return null;
  const w = parsed.data;
  const title = w.display_name?.trim() ?? '';
  if (!title) return null;
  const doiRaw = w.doi ? normalizeDoi(w.doi) : '';
  const doi = /^10\.\d{4,}/.test(doiRaw) ? doiRaw : null;
  const authors =
    w.authorships
      ?.map((a) => a.author?.display_name?.trim())
      .filter((n): n is string => Boolean(n))
      .slice(0, 20)
      .join('; ') || null;
  const landing = w.primary_location?.landing_page_url;
  const url = landing && /^https?:\/\//i.test(landing) ? landing : doi ? `https://doi.org/${doi}` : w.id;
  return {
    key: `w${index}`,
    title,
    authors,
    year: yearFromWork(w.publication_year, w.publication_date),
    doi,
    url,
    venue: w.primary_location?.source?.display_name?.trim() || null,
    abstract: rebuildAbstract(w.abstract_inverted_index),
    item_type: itemTypeFromOpenAlex(w.type),
  };
}

export function candidateToRecord(c: BibliographyCandidate): BibliographyRecord {
  const parsed = bibliographyRecordSchema.safeParse({
    title: c.title,
    authors: c.authors,
    year: c.year,
    doi: c.doi,
    url: c.url,
    venue: c.venue,
    abstract: c.abstract,
    item_type: c.item_type,
  });
  return parsed.success ? parsed.data : EMPTY_RECORD;
}

/**
 * OpenAlex の候補から同一論文を切る。生成しない。
 * choice と noul は独立（並列）なので、両方をコードで AND する。
 */
export function adoptCandidate(
  answers: Record<string, unknown>,
  candidates: BibliographyCandidate[],
  policy = JEV_POLICY.C1,
): BibliographyCandidate | null {
  const match = parseChoice(answers.match);
  const same = parseNoul(answers.same_work);
  if (!match || !same) return null;
  if (match.choice === NONE_KEY) return null;
  if ((match.confidence ?? 0) < policy.minConfidence) return null;
  if (same.noul < policy.minNoul) return null;
  return candidates.find((c) => c.key === match.choice) ?? null;
}

export function bibliographyQuestions(candidates: BibliographyCandidate[]): Record<string, JevQuestion> {
  const criteria: Record<string, string | null> = { [NONE_KEY]: 'None of the candidates is the same published work as the hint' };
  for (const c of candidates) {
    const bits = [c.title, c.year ? String(c.year) : null, c.doi].filter(Boolean).join(' · ');
    criteria[c.key] = bits;
  }
  return {
    match: {
      type: 'choice',
      instructions:
        'Which candidate is the same published scholarly work as `hint`? Pick `none` if it is a different work or you cannot tell.',
      criteria,
    },
    same_work: {
      type: 'noul',
      instructions: 'At least one candidate is the same published scholarly work as `hint`.',
      criteria: {
        true: 'A candidate is the same work; its public bibliographic fields can be copied.',
        false: 'No candidate is the same work, or it is only a guess.',
      },
    },
  };
}

export function openAlexBibliographyUrl(hint: BibliographyHint, opts: { apiKey?: string } = {}): URL {
  const url = new URL('https://api.openalex.org/works');
  url.searchParams.set('per-page', '5');
  url.searchParams.set(
    'select',
    'id,doi,display_name,publication_year,publication_date,type,authorships,primary_location,abstract_inverted_index',
  );
  if (opts.apiKey) url.searchParams.set('api_key', opts.apiKey);
  if (hint.doi) {
    url.searchParams.set('filter', `doi:${normalizeDoi(hint.doi)}`);
  } else {
    url.searchParams.set('search', (hint.title ?? '').split(/\s+/).slice(0, 24).join(' '));
  }
  return url;
}

const resultsSchema = z.object({ results: z.array(z.unknown()).optional() });

export async function fetchBibliographyCandidates(
  hint: BibliographyHint,
  opts: { apiKey?: string } = {},
): Promise<BibliographyCandidate[]> {
  const res = await fetch(openAlexBibliographyUrl(hint, opts), {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`openalex status=${res.status}`);
  const parsed = resultsSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error('openalex response invalid');
  const out: BibliographyCandidate[] = [];
  for (const raw of parsed.data.results ?? []) {
    const c = workToCandidate(raw, out.length);
    if (c) out.push(c);
    if (out.length >= 5) break;
  }
  return out;
}

export type BibliographyOk = {
  ok: true;
  record: BibliographyRecord;
  model: string | null;
  tokens: number;
};
export type BibliographyFail = { ok: false; status: number; detail: string };

export async function completeBibliography(
  typesafeKey: string,
  hint: BibliographyHint,
  openAlexKey?: string,
): Promise<BibliographyOk | BibliographyFail> {
  let candidates: BibliographyCandidate[];
  try {
    candidates = await fetchBibliographyCandidates(hint, { apiKey: openAlexKey });
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'openalex';
    return { ok: false, status: 502, detail };
  }

  if (candidates.length === 0) {
    return { ok: true, record: EMPTY_RECORD, model: null, tokens: 0 };
  }

  const llm = await systemOne(
    typesafeKey,
    {
      hint: {
        title: hint.title ?? null,
        doi: hint.doi ? normalizeDoi(hint.doi) : null,
        authors: hint.authors ?? null,
        year: hint.year ?? null,
        venue: hint.venue ?? null,
      },
      candidates: candidates.map((c) => ({
        key: c.key,
        title: c.title,
        authors: c.authors,
        year: c.year,
        doi: c.doi,
        venue: c.venue,
      })),
    },
    bibliographyQuestions(candidates),
  );
  if (!llm.ok) return { ok: false, status: 502, detail: 'typesafe' };

  const chosen = adoptCandidate(llm.answers, candidates);
  return {
    ok: true,
    record: chosen ? candidateToRecord(chosen) : EMPTY_RECORD,
    model: llm.model,
    tokens: llm.tokens,
  };
}
