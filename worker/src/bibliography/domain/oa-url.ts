import { z } from 'zod';

/** https の直 PDF だけ。HTML ランディングと http は捨てる（ADR-0003） */
export function httpsPdfUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const u = raw.trim();
  if (!/^https:\/\//i.test(u)) return null;
  if (/\.html?(?:[?#]|$)/i.test(u)) return null;
  if (u.length > 2000) return null;
  return u;
}

const oaLocSchema = z
  .object({
    pdf_url: z.string().nullable().optional(),
    landing_page_url: z.string().nullable().optional(),
  })
  .nullable()
  .optional();

const oaWorkSchema = z.object({
  doi: z.string().nullable().optional(),
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

/** OpenAlex の work JSON から OA 直 PDF だけ拾う。HTTP は知らない */
export function oaPdfUrlFromWork(raw: unknown): string | null {
  const parsed = oaWorkSchema.safeParse(raw);
  if (!parsed.success) return null;
  const w = parsed.data;
  return (
    httpsPdfUrl(w.best_oa_location?.pdf_url) ??
    httpsPdfUrl(w.primary_location?.pdf_url) ??
    httpsPdfUrl(w.open_access?.oa_url)
  );
}
