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
});

export const openAlexWorkSchema = z.object({
  id: z.string(),
  doi: z.string().nullable().optional(),
  display_name: z.string().optional(),
  publication_date: z.string().optional(),
  abstract_inverted_index: z.record(z.string(), z.array(z.number())).nullable().optional(),
});

export const openAlexResponseSchema = z.object({
  results: z.array(openAlexWorkSchema).optional(),
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
