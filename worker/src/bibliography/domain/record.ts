/**
 * 書誌のドメイン。Orca / OpenAlex / HTTP に依存しない。
 */
import { z } from 'zod';
import { normalizeDoi } from './doi';

const ITEM_TYPES = ['article', 'inproceedings', 'book', 'phdthesis', 'misc'] as const;
export const FIRST_PAGE_MAX = 4000;

export const bibliographyHintSchema = z
  .object({
    title: z.string().trim().max(500).optional(),
    authors: z.string().trim().max(500).optional(),
    year: z.number().int().min(1000).max(2100).optional(),
    doi: z.string().trim().max(200).optional(),
    url: z.string().trim().max(2000).optional(),
    venue: z.string().trim().max(300).optional(),
    abstract: z.string().trim().max(2000).optional(),
    first_page: z.string().trim().max(FIRST_PAGE_MAX).optional(),
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

export const EMPTY_RECORD: BibliographyRecord = {
  title: null,
  authors: null,
  year: null,
  doi: null,
  url: null,
  venue: null,
  abstract: null,
  item_type: 'article',
};

export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced?.[1] ?? trimmed).trim();
  return JSON.parse(body) as unknown;
}

export function recordFromModelText(text: string): BibliographyRecord {
  let raw: unknown;
  try {
    raw = parseJsonObject(text);
  } catch {
    return EMPTY_RECORD;
  }
  const parsed = bibliographyRecordSchema.safeParse(raw);
  return parsed.success ? parsed.data : EMPTY_RECORD;
}

export function bibliographyPrompt(hint: BibliographyHint): string {
  return [
    'Fill a bibliographic record for one published scholarly work.',
    'Use only the hint and first_page below. Do not invent a DOI that is not in the input.',
    'If a field is unknown, use JSON null. item_type must be one of: article, inproceedings, book, phdthesis, misc.',
    'Reply with a JSON object only: title, authors, year, doi, url, venue, abstract, item_type.',
    `hint: ${JSON.stringify({
      title: hint.title ?? null,
      authors: hint.authors ?? null,
      year: hint.year ?? null,
      doi: hint.doi ? normalizeDoi(hint.doi) : null,
      url: hint.url ?? null,
      venue: hint.venue ?? null,
      abstract: hint.abstract ?? null,
    })}`,
    hint.first_page ? `first_page:\n${hint.first_page.slice(0, FIRST_PAGE_MAX)}` : 'first_page: null',
  ].join('\n\n');
}
