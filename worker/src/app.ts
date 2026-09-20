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
} from './schema';

export type AppEnv = { Bindings: Env };

export const app = new OpenAPIHono<AppEnv>();

const ACCESS_TTL_SEC = 15 * 60;

function abort(fail: AuthFail): never {
  throw new HTTPException(fail.status, {
    res: Response.json(fail.body, { status: fail.status }),
  });
}

const unauthorized = {
  401: {
    description: 'Bearer access が無い / 無効',
    content: { 'application/json': { schema: ErrorSchema } },
  },
} as const;

const notImplemented = {
  501: {
    description: '未決のため閉じている。空配列で「0 件」に見せかけない（C-07）',
    content: { 'application/json': { schema: ErrorSchema } },
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
  detail: 'BFF endpoint は分類（C1/C2/C3）決定後に追加する',
} as const;

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
