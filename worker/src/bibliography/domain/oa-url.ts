import { z } from 'zod';
import { authorsFromAuthorships } from '../../shared/papers/domain';

/** https の直 PDF だけ。HTML ランディングと http は捨てる（ADR-0003） */
export function httpsPdfUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const u = raw.trim();
  if (!/^https:\/\//i.test(u)) return null;
  if (/\.html?(?:[?#]|$)/i.test(u)) return null;
  if (u.length > 2000) return null;
  return u;
}

const oaLocObjectSchema = z.object({
  pdf_url: z.string().nullable().optional(),
  landing_page_url: z.string().nullable().optional(),
  source: z
    .object({ display_name: z.string().nullable().optional() })
    .nullable()
    .optional(),
});

const oaLocSchema = oaLocObjectSchema.nullable().optional();

const oaWorkSchema = z.object({
  doi: z.string().nullable().optional(),
  display_name: z.string().nullable().optional(),
  publication_year: z.number().int().nullable().optional(),
  authorships: z.array(z.unknown()).nullable().optional(),
  best_oa_location: oaLocSchema,
  primary_location: oaLocSchema,
  open_access: z
    .object({
      oa_url: z.string().nullable().optional(),
      is_oa: z.boolean().optional(),
    })
    .nullable()
    .optional(),
});

export type OaBiblio = {
  title: string | null;
  authors: string | null;
  year: number | null;
  venue: string | null;
  pdf_url: string | null;
};

/** OpenAlex の work JSON から OA 直 PDF だけ拾う。HTTP は知らない */
export function oaPdfUrlFromWork(raw: unknown): string | null {
  return oaBiblioFromWork(raw).pdf_url;
}

/**
 * DOI で引いた 1 件から公開書誌を拾う。検索して同一論文かを切る経路ではない（ADR-0002）。
 * 取れない項目は null（C-07）。
 */
export function oaBiblioFromWork(raw: unknown): OaBiblio {
  const parsed = oaWorkSchema.safeParse(raw);
  if (!parsed.success) {
    return { title: null, authors: null, year: null, venue: null, pdf_url: null };
  }
  const w = parsed.data;
  const year = w.publication_year;
  return {
    title: w.display_name?.trim() || null,
    authors: authorsFromAuthorships(w.authorships),
    year: year && year >= 1000 && year <= 2100 ? year : null,
    venue: w.primary_location?.source?.display_name?.trim() || null,
    pdf_url:
      httpsPdfUrl(w.best_oa_location?.pdf_url) ??
      httpsPdfUrl(w.primary_location?.pdf_url) ??
      httpsPdfUrl(w.open_access?.oa_url),
  };
}
