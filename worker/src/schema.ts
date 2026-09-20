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
