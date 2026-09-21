import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { requireAccess, requireRefresh, type AuthFail } from './auth/guard';
import { signAccessToken } from './auth/jwt';
import type { Env } from './env';
import {
  ErrorSchema,
  HealthSchema,
  RefreshBodySchema,
  TokenResponseSchema,
  TrendBodySchema,
  TrendResponseSchema,
  BibliographyBodySchema,
  BibliographyResponseSchema,
} from './schema';
import { TREND_ENDPOINT, fetchPublicPapers, summarizeTrend, toTrendPapers } from './trend';
import { BIBLIOGRAPHY_ENDPOINT, bibliographyHintSchema, completeBibliography } from './bibliography';
import { orcaKey } from './orca';
import { ORCA_POLICY } from './orca-policy';
import { dailyCallCount, dailyCallLimit, ensureUserId, recordLlmUsage } from './usage';

export type AppEnv = { Bindings: Env };

export const app = new OpenAPIHono<AppEnv>();

const ACCESS_TTL_SEC = 15 * 60;

function abort(fail: AuthFail): never {
  throw new HTTPException(fail.status, {
    res: Response.json(fail.body, { status: fail.status }),
  });
}

function fail(status: 429 | 501 | 502, body: { error: string; detail?: string }): never {
  throw new HTTPException(status, {
    res: Response.json(body, { status }),
  });
}

const jsonError = {
  content: { 'application/json': { schema: ErrorSchema } },
} as const;

const unauthorized = {
  401: { description: 'Bearer access が無い / 無効', ...jsonError },
} as const;

const notImplemented = {
  501: {
    description: '未決のため閉じている。空配列で「0 件」に見せかけない（C-07）',
    ...jsonError,
  },
} as const;

app.openapi(
  createRoute({
    method: 'get',
    path: '/health',
    responses: {
      200: {
        description: '死活確認。認証前に置く唯一の経路',
        content: { 'application/json': { schema: HealthSchema } },
      },
    },
  }),
  (c) => c.json({ ok: true as const, environment: c.env.ENVIRONMENT }, 200),
);

app.openapi(
  createRoute({
    method: 'post',
    path: '/auth/refresh',
    request: {
      body: {
        content: { 'application/json': { schema: RefreshBodySchema } },
        required: true,
      },
    },
    responses: {
      200: {
        description: '新しい access。refresh 自体はクライアントの保護領域に残す',
        content: { 'application/json': { schema: TokenResponseSchema } },
      },
      ...unauthorized,
      ...notImplemented,
    },
  }),
  async (c) => {
    const { refresh_token } = c.req.valid('json');
    const auth = await requireRefresh(c.env, refresh_token);
    if (!auth.ok) abort(auth);
    const access_token = await signAccessToken(c.env.JWT_SIGNING_KEY!, auth.payload.sub!);
    return c.json(
      { access_token, token_type: 'bearer' as const, expires_in: ACCESS_TTL_SEC },
      200,
    );
  },
);

app.openapi(
  createRoute({
    method: 'get',
    path: '/runs',
    responses: {
      ...unauthorized,
      ...notImplemented,
    },
  }),
  async (c) => {
    const auth = await requireAccess(c.env, c.req.raw);
    if (!auth.ok) abort(auth);
    abort({
      ok: false,
      status: 501,
      body: { error: 'not_implemented', detail: '同期 API の中身は未実装。認証だけ通った' },
    });
  },
);

const bffBody = {
  error: 'not_implemented',
  detail: 'C2/C3 は同意・プレビューが未実装のため閉じている',
} as const;

app.openapi(
  createRoute({
    method: 'post',
    path: '/bff/trends',
    request: {
      body: {
        content: { 'application/json': { schema: TrendBodySchema } },
        required: true,
      },
    },
    responses: {
      200: {
        description: 'C1 トレンド。0 件なら summary は null（C-07）',
        content: { 'application/json': { schema: TrendResponseSchema } },
      },
      ...unauthorized,
      429: { description: '利用者単位の上限（NFR-04）', ...jsonError },
      ...notImplemented,
      502: { description: 'OpenAlex または OrcaRouter が欠けた', ...jsonError },
    },
  }),
  async (c) => {
    const auth = await requireAccess(c.env, c.req.raw);
    if (!auth.ok) abort(auth);

    const apiKey = orcaKey(c.env, ORCA_POLICY.C1.slot);
    if (!apiKey) {
      fail(501, { error: 'not_implemented', detail: 'ORCAROUTER_API_KEY が未設定' });
    }

    const userId = await ensureUserId(c.env.DB, auth.payload.sub!);
    const limit = dailyCallLimit(c.env);
    const used = await dailyCallCount(c.env.DB, userId);
    if (used >= limit) {
      fail(429, { error: 'rate_limited', detail: 'daily LLM call limit' });
    }

    const { topic } = c.req.valid('json');

    let papers;
    try {
      papers = await fetchPublicPapers(topic, { apiKey: c.env.OPENALEX_API_KEY });
    } catch (e) {
      const detail = e instanceof Error ? e.message : 'openalex';
      fail(502, { error: 'source_failed', detail });
    }

    // 公開論文が 0 件なら LLM を呼ばない。トレンドを捏造しない（C-07）
    if (papers.length === 0) {
      return c.json(
        { classification: 'C1' as const, model: null, summary: null, papers: [] },
        200,
      );
    }

    const llm = await summarizeTrend(apiKey, topic, papers);
    if (!llm.ok) {
      fail(502, { error: 'upstream_failed', detail: 'orcarouter' });
    }

    await recordLlmUsage(c.env.DB, {
      userId,
      endpoint: TREND_ENDPOINT,
      classification: 'C1',
      requestedModel: llm.requestedModel,
      resolvedModel: llm.model,
      tokens: llm.tokens,
      costUsd: llm.costUsd,
      latencyMs: llm.latencyMs,
      fallbackUsed: llm.fallbackUsed,
    });

    return c.json(
      {
        classification: 'C1' as const,
        model: llm.model,
        summary: llm.summary,
        papers: toTrendPapers(papers),
      },
      200,
    );
  },
);

app.openapi(
  createRoute({
    method: 'post',
    path: '/bff/bibliography',
    request: {
      body: {
        content: { 'application/json': { schema: BibliographyBodySchema } },
        required: true,
      },
    },
    responses: {
      200: {
        description: 'C1 公開書誌の補完。OpenAlex で埋め、Jev で同一論文かを切る。不採用は null（C-07）',
        content: { 'application/json': { schema: BibliographyResponseSchema } },
      },
      ...unauthorized,
      429: { description: '利用者単位の上限（NFR-04）', ...jsonError },
      ...notImplemented,
      502: { description: 'OpenAlex または TypeSafe Jev が欠けた', ...jsonError },
    },
  }),
  async (c) => {
    const auth = await requireAccess(c.env, c.req.raw);
    if (!auth.ok) abort(auth);

    const apiKey = c.env.JEV_API_KEY;
    if (!apiKey) {
      fail(501, { error: 'not_implemented', detail: 'JEV_API_KEY が未設定' });
    }

    const userId = await ensureUserId(c.env.DB, auth.payload.sub!);
    const limit = dailyCallLimit(c.env);
    const used = await dailyCallCount(c.env.DB, userId);
    if (used >= limit) {
      fail(429, { error: 'rate_limited', detail: 'daily LLM call limit' });
    }

    const hint = bibliographyHintSchema.safeParse(c.req.valid('json'));
    if (!hint.success) {
      throw new HTTPException(400, {
        res: Response.json({ error: 'invalid_body', detail: 'title or doi required' }, { status: 400 }),
      });
    }

    const llm = await completeBibliography(apiKey, hint.data, c.env.OPENALEX_API_KEY);
    if (!llm.ok) {
      fail(502, { error: 'upstream_failed', detail: llm.detail });
    }

    if (llm.model) {
      await recordLlmUsage(c.env.DB, {
        userId,
        endpoint: BIBLIOGRAPHY_ENDPOINT,
        classification: 'C1',
        model: llm.model,
        tokens: llm.tokens,
      });
    }

    return c.json({ classification: 'C1' as const, model: llm.model, record: llm.record }, 200);
  },
);

app.openapi(
  createRoute({
    method: 'get',
    path: '/bff/{name}',
    request: { params: z.object({ name: z.string() }) },
    responses: { ...unauthorized, ...notImplemented },
  }),
  async (c) => {
    const auth = await requireAccess(c.env, c.req.raw);
    if (!auth.ok) abort(auth);
    abort({ ok: false, status: 501, body: bffBody });
  },
);

app.openapi(
  createRoute({
    method: 'post',
    path: '/bff/{name}',
    request: { params: z.object({ name: z.string() }) },
    responses: { ...unauthorized, ...notImplemented },
  }),
  async (c) => {
    const auth = await requireAccess(c.env, c.req.raw);
    if (!auth.ok) abort(auth);
    abort({ ok: false, status: 501, body: bffBody });
  },
);

app.doc('/doc', {
  openapi: '3.0.0',
  info: { title: 'ai-research-api', version: '0.1.0' },
});

app.notFound((c) => c.json({ error: 'not_found' }, 404));

export const handleFetch = (request: Request, env: Env, ctx?: ExecutionContext) =>
  app.fetch(request, env, ctx);
