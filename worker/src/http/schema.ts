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

export const LoginTokenResponseSchema = z
  .object({
    access_token: z.string(),
    refresh_token: z.string(),
    token_type: z.literal('bearer'),
    expires_in: z.number(),
  })
  .openapi('LoginTokenResponse');

export const GoogleClientSchema = z
  .object({
    client_id: z.string().min(1),
  })
  .openapi('GoogleClient');

export const GoogleLoginBodySchema = z
  .object({
    code: z.string().min(1).max(512),
    code_verifier: z.string().min(43).max(128),
    redirect_uri: z.string().url().max(500),
  })
  .openapi('GoogleLoginBody');

export const TrendBodySchema = z
  .object({
    topic: z.string().trim().min(1).max(200),
    // 収集済みの公開論文。あれば OpenAlex を取り直さない
    papers: z
      .array(
        z.object({
          title: z.string().trim().min(1).max(500),
          abstract: z.string().max(4000).nullable().optional(),
          url: z.string().max(2000).nullable().optional(),
          published_at: z.string().max(32).nullable().optional(),
        }),
      )
      .max(12)
      .optional(),
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
    themes: z.array(z.string()),
    papers: z.array(TrendPaperSchema),
  })
  .openapi('TrendResponse');

export const KeywordsBodySchema = z
  .object({
    topic: z.string().trim().min(1).max(2000),
  })
  .openapi('KeywordsBody');

export const KeywordsResponseSchema = z
  .object({
    classification: z.literal('C1'),
    model: z.string().nullable(),
    terms: z.array(z.string()),
  })
  .openapi('KeywordsResponse');

export const BibliographyBodySchema = z
  .object({
    title: z.string().trim().max(500).optional(),
    authors: z.string().trim().max(500).optional(),
    year: z.number().int().min(1000).max(2100).optional(),
    doi: z.string().trim().max(200).optional(),
    url: z.string().trim().max(2000).optional(),
    venue: z.string().trim().max(300).optional(),
    abstract: z.string().trim().max(2000).optional(),
    first_page: z.string().trim().max(4000).optional(),
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
    pdf_url: z.string().nullable(),
  })
  .openapi('BibliographyResponse');

export const RunPaperSchema = z
  .object({
    external_id: z.string(),
    source: z.string(),
    title: z.string(),
    authors: z.string().nullable(),
    abstract: z.string().nullable(),
    url: z.string().nullable(),
    published_at: z.string().nullable(),
    /** 掲載誌・会議名。引用に要るので候補の時点で載せる */
    venue: z.string().nullable(),
    item_type: z.string().nullable(),
    /** OA の直 PDF。無ければ null = 未取得（C-07）。取得はデスクトップ */
    pdf_url: z.string().nullable(),
    coarse_score: z.number().nullable(),
    problem_excerpt: z.string().nullable(),
  })
  .openapi('RunPaper');

export const RunSchema = z
  .object({
    run_id: z.string(),
    run_date: z.string(),
    status: z.enum(['ok', 'empty', 'failed', 'partial']),
    failed_sources_json: z.string().nullable(),
    search_terms: z.array(z.string()),
    trend: z.string().nullable(),
    themes: z.array(z.string()),
    created_at: z.string(),
    papers: z.array(RunPaperSchema),
  })
  .openapi('Run');

export const RunsResponseSchema = z
  .object({
    project_id: z.string(),
    runs: z.array(RunSchema),
  })
  .openapi('RunsResponse');

export const ProjectPutBodySchema = z
  .object({
    title: z.string().trim().min(1),
    summary: z.string().trim().min(1),
  })
  .openapi('ProjectPutBody');

export const ProjectResponseSchema = z
  .object({
    project_id: z.string(),
    title: z.string(),
    summary: z.string(),
  })
  .openapi('ProjectResponse');

export const CollectAcceptedSchema = z
  .object({
    project_id: z.string(),
    run_id: z.string(),
    run_date: z.string(),
    enqueued: z.number().int().nonnegative(),
  })
  .openapi('CollectAccepted');
