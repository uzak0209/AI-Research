import { z } from '@hono/zod-openapi';

export const ErrorSchema = z
  .object({
    error: z.string(),
    detail: z.string().optional(),
  })
  .openapi('Error');

export const HealthSchema = z
  .object({
    ok: z.literal(true),
    environment: z.string(),
  })
  .openapi('Health');

export const RefreshBodySchema = z
  .object({ refresh_token: z.string().min(1) })
  .openapi('RefreshBody');

export const TokenResponseSchema = z
  .object({
    access_token: z.string(),
    token_type: z.literal('bearer'),
    expires_in: z.number(),
  })
  .openapi('TokenResponse');

export const collectMessageSchema = z.object({
  run_id: z.string().min(1),
  project_id: z.string().min(1),
  summary: z.string(),
  source: z.string().min(1),
  run_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // 収集段の LLM 利用を誰の分として数えるか（NFR-04）。
  // 配送中の古いメッセージには無いので optional。無ければ project から引く
  user_id: z.string().min(1).optional(),
});

export const openAlexWorkSchema = z.object({
  id: z.string(),
  doi: z.string().nullable().optional(),
  display_name: z.string().nullable().optional(),
  publication_date: z.string().nullable().optional(),
  abstract_inverted_index: z.record(z.string(), z.array(z.number())).nullable().optional(),
});

export const openAlexResponseSchema = z.object({
  results: z.array(z.unknown()).optional(),
});

export const TrendBodySchema = z
  .object({
    // トピックだけ。原稿や手元論文を載せない（C-01, C-09）
    topic: z.string().trim().min(1).max(200),
  })
  .openapi('TrendBody');

export const TrendPaperSchema = z
  .object({
    title: z.string(),
    url: z.string().nullable(),
    published_at: z.string().nullable(),
  })
  .openapi('TrendPaper');

export const TrendResponseSchema = z
  .object({
    classification: z.literal('C1'),
    model: z.string().nullable(),
    summary: z.string().nullable(),
    papers: z.array(TrendPaperSchema),
  })
  .openapi('TrendResponse');

export const BibliographyBodySchema = z
  .object({
    title: z.string().trim().max(500).optional(),
    authors: z.string().trim().max(500).optional(),
    year: z.number().int().min(1000).max(2100).optional(),
    doi: z.string().trim().max(200).optional(),
    url: z.string().trim().max(2000).optional(),
    venue: z.string().trim().max(300).optional(),
    abstract: z.string().trim().max(2000).optional(),
  })
  .refine((h) => Boolean(h.title || h.doi), { message: 'title or doi required' })
  .openapi('BibliographyBody');

export const BibliographyRecordSchema = z
  .object({
    title: z.string().nullable(),
    authors: z.string().nullable(),
    year: z.number().int().nullable(),
    doi: z.string().nullable(),
    url: z.string().nullable(),
    venue: z.string().nullable(),
    abstract: z.string().nullable(),
    item_type: z.string(),
  })
  .openapi('BibliographyRecord');

export const BibliographyResponseSchema = z
  .object({
    classification: z.literal('C1'),
    model: z.string().nullable(),
    record: BibliographyRecordSchema,
  })
  .openapi('BibliographyResponse');
