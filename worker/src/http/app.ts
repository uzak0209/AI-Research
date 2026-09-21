import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { createAuth, isLoopbackRedirect, signAccessToken, type AuthFail } from '../auth';
import type { Env } from '../env';
import {
  ErrorSchema,
  HealthSchema,
  RefreshBodySchema,
  TokenResponseSchema,
  LoginTokenResponseSchema,
  GoogleClientSchema,
  GoogleLoginBodySchema,
  TrendBodySchema,
  TrendResponseSchema,
  BibliographyBodySchema,
  BibliographyResponseSchema,
} from './schema';
import { TREND_ENDPOINT, createTrendApp } from '../trend';
import { BIBLIOGRAPHY_ENDPOINT, bibliographyHintSchema, createBibliographyApp } from '../bibliography';
import { orcaKey } from '../shared/orca/chat';
import { ORCA_POLICY } from '../shared/orca/policy';
import { createUsage } from '../usage';

export type AppEnv = { Bindings: Env };

export const app = new OpenAPIHono<AppEnv>();

const ACCESS_TTL_SEC = 15 * 60;

function abort(fail: AuthFail): never {
  throw new HTTPException(fail.status, {
    res: Response.json(fail.body, { status: fail.status }),
  });
}

function fail(status: 400 | 401 | 429 | 501 | 502, body: { error: string; detail?: string }): never {
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
    const auth = await createAuth(c.env).requireRefresh(refresh_token);
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
    path: '/auth/google',
    responses: {
      200: {
        description: 'Electron が authorize URL を組むための client_id。secret は出さない',
        content: { 'application/json': { schema: GoogleClientSchema } },
      },
      ...notImplemented,
    },
  }),
  (c) => {
    const clientId = c.env.GOOGLE_OAUTH_CLIENT_ID;
    const secret = c.env.GOOGLE_OAUTH_CLIENT_SECRET;
    if (!clientId || !secret) {
      fail(501, { error: 'not_implemented', detail: 'GOOGLE_OAUTH_CLIENT_ID / SECRET が未設定' });
    }
    return c.json({ client_id: clientId }, 200);
  },
);

app.openapi(
  createRoute({
    method: 'post',
    path: '/auth/google',
    request: {
      body: {
        content: { 'application/json': { schema: GoogleLoginBodySchema } },
        required: true,
      },
    },
    responses: {
      200: {
        description: '自前 JWT。Google の access は返さない',
        content: { 'application/json': { schema: LoginTokenResponseSchema } },
      },
      400: { description: 'redirect_uri がループバックではない', ...jsonError },
      ...unauthorized,
      ...notImplemented,
      502: { description: 'Google が欠けた', ...jsonError },
    },
  }),
  async (c) => {
    const signing = c.env.JWT_SIGNING_KEY;
    const clientId = c.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = c.env.GOOGLE_OAUTH_CLIENT_SECRET;
    if (!signing) fail(501, { error: 'not_implemented', detail: 'JWT_SIGNING_KEY が未設定' });
    if (!clientId || !clientSecret) {
      fail(501, { error: 'not_implemented', detail: 'GOOGLE_OAUTH_CLIENT_ID / SECRET が未設定' });
    }

    const body = c.req.valid('json');
    if (!isLoopbackRedirect(body.redirect_uri)) {
      fail(400, { error: 'invalid_redirect', detail: 'redirect_uri must be http://127.0.0.1' });
    }

    const google = await createAuth(c.env).loginGoogle({
      clientId,
      clientSecret,
      signingKey: signing,
      code: body.code,
      redirectUri: body.redirect_uri,
      codeVerifier: body.code_verifier,
    });
    if (!google.ok) fail(google.status, { error: 'upstream_failed', detail: google.detail });

    return c.json(
      {
        access_token: google.access_token,
        refresh_token: google.refresh_token,
        token_type: 'bearer' as const,
        expires_in: ACCESS_TTL_SEC,
      },
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
    const auth = await createAuth(c.env).requireAccess(c.req.raw);
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
    const auth = await createAuth(c.env).requireAccess(c.req.raw);
    if (!auth.ok) abort(auth);

    const apiKey = orcaKey(c.env, ORCA_POLICY.C1.slot);
    if (!apiKey) {
      fail(501, { error: 'not_implemented', detail: 'ORCAROUTER_API_KEY が未設定' });
    }

    const usage = createUsage(c.env);
    const userId = await usage.ensureUser(auth.payload.sub!);
    const used = await usage.dailyCallCount(userId);
    if (used >= usage.limit) {
      fail(429, { error: 'rate_limited', detail: 'daily LLM call limit' });
    }

    const { topic } = c.req.valid('json');
    const got = await createTrendApp({ orcaKey: apiKey, openAlexKey: c.env.OPENALEX_API_KEY }).survey(topic);
    if (!got.ok) {
      if (got.detail === 'orcarouter') fail(502, { error: 'upstream_failed', detail: 'orcarouter' });
      fail(502, { error: 'source_failed', detail: got.detail });
    }

    if (got.model) {
      await usage.record({
        userId,
        endpoint: TREND_ENDPOINT,
        classification: 'C1',
        model: got.model,
        tokens: got.tokens,
      });
    }

    return c.json(
      {
        classification: 'C1' as const,
        model: got.model,
        summary: got.summary,
        papers: got.papers,
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
        description: 'C1 公開書誌の補完。Orca 安価モデルの構造化出力。pdf_url は OA 直リンクのみ（C-07）',
        content: { 'application/json': { schema: BibliographyResponseSchema } },
      },
      ...unauthorized,
      429: { description: '利用者単位の上限（NFR-04）', ...jsonError },
      ...notImplemented,
      502: { description: 'OrcaRouter が欠けた', ...jsonError },
    },
  }),
  async (c) => {
    const auth = await createAuth(c.env).requireAccess(c.req.raw);
    if (!auth.ok) abort(auth);

    const apiKey = orcaKey(c.env, ORCA_POLICY.C1.slot);
    if (!apiKey) {
      fail(501, { error: 'not_implemented', detail: 'ORCAROUTER_API_KEY が未設定' });
    }

    const usage = createUsage(c.env);
    const userId = await usage.ensureUser(auth.payload.sub!);
    const used = await usage.dailyCallCount(userId);
    if (used >= usage.limit) {
      fail(429, { error: 'rate_limited', detail: 'daily LLM call limit' });
    }

    const hint = bibliographyHintSchema.safeParse(c.req.valid('json'));
    if (!hint.success) {
      throw new HTTPException(400, {
        res: Response.json({ error: 'invalid_body', detail: 'title or doi required' }, { status: 400 }),
      });
    }

    const llm = await createBibliographyApp({ orcaKey: apiKey, openAlexKey: c.env.OPENALEX_API_KEY }).complete(
      hint.data,
    );
    if (!llm.ok) {
      fail(502, { error: 'upstream_failed', detail: llm.detail });
    }

    if (llm.model) {
      await usage.record({
        userId,
        endpoint: BIBLIOGRAPHY_ENDPOINT,
        classification: 'C1',
        model: llm.model,
        tokens: llm.tokens,
      });
    }

    return c.json(
      { classification: 'C1' as const, model: llm.model, record: llm.record, pdf_url: llm.pdf_url },
      200,
    );
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
    const auth = await createAuth(c.env).requireAccess(c.req.raw);
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
    const auth = await createAuth(c.env).requireAccess(c.req.raw);
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
