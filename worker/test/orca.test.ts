import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatBody, chatCompletion, orcaKey } from '../src/shared/orca/chat';
import {
  ORCA_POLICY,
  collectPolicy,
  reviewPolicy,
  fallbackChain,
  DEFAULT_COLLECT_ROUTER,
  DEFAULT_REVIEW_ROUTER,
  COLLECT_MAX_TOKENS,
  REVIEW_MAX_TOKENS,
  BIBLIOGRAPHY_MAX_TOKENS,
} from '../src/shared/orca/policy';
import type { Env } from '../src/env';

describe('orcaKey', () => {
  it('interactive は INTERACTIVE を ORCAROUTER_API_KEY より優先する', () => {
    const env = {
      ORCAROUTER_API_KEY: 'legacy',
      ORCAROUTER_API_KEY_INTERACTIVE: 'interactive',
    } as Env;
    expect(orcaKey(env, 'interactive')).toBe('interactive');
  });

  it('sensitive は interactive に落ちない', () => {
    const env = { ORCAROUTER_API_KEY: 'legacy' } as Env;
    expect(orcaKey(env, 'sensitive')).toBeUndefined();
  });
});

describe('段ごとのルーター（ADR-0005 §2）', () => {
  it('収集とレビューで別の Named Router を要求する', () => {
    const env = {} as Env;
    expect(collectPolicy(env).model).toBe(DEFAULT_COLLECT_ROUTER);
    expect(reviewPolicy(env).model).toBe(DEFAULT_REVIEW_ROUTER);
    expect(collectPolicy(env).model).not.toBe(reviewPolicy(env).model);
  });

  it('収集は cron キー、レビューは interactive キーを使う', () => {
    const env = {} as Env;
    expect(collectPolicy(env).slot).toBe('cron');
    expect(reviewPolicy(env).slot).toBe('interactive');
  });

  it('var があればルーター名を差し替えられる（コンソール未整備時の逃げ道）', () => {
    const env = { ORCA_ROUTER_REVIEW: 'anthropic/claude-haiku-4.5' } as Env;
    expect(reviewPolicy(env).model).toBe('anthropic/claude-haiku-4.5');
  });

  it('Named Router がコンソールに無くても extra_body の次へ落ちる', () => {
    const body = chatBody(reviewPolicy({} as Env), [{ role: 'user', content: 'x' }]);
    expect(body.model).toBe(DEFAULT_REVIEW_ROUTER);
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(REVIEW_MAX_TOKENS);
    expect(body.extra_body).toEqual({
      route: 'fallback',
      models: [DEFAULT_REVIEW_ROUTER, 'google/gemini-2.5-flash', 'anthropic/claude-haiku-4.5'],
    });
  });

  it('収集も検索語の受け皿と完了トークン上限を付ける', () => {
    const body = chatBody(collectPolicy({} as Env), [{ role: 'user', content: 'x' }]);
    expect(body.model).toBe(DEFAULT_COLLECT_ROUTER);
    expect(body.max_tokens).toBe(COLLECT_MAX_TOKENS);
    expect(body.extra_body).toEqual({
      route: 'fallback',
      models: [DEFAULT_COLLECT_ROUTER, 'openai/gpt-4o-mini', 'google/gemini-2.5-flash'],
    });
  });

  it('C1 書誌は Named Router を使わず extra_body を付ける', () => {
    const body = chatBody(ORCA_POLICY.C1, [{ role: 'user', content: 'x' }]);
    expect(body.model).toBe('openai/gpt-4o-mini');
    expect(body.max_tokens).toBe(BIBLIOGRAPHY_MAX_TOKENS);
    expect(body.extra_body).toEqual({
      route: 'fallback',
      models: ['openai/gpt-4o-mini', 'google/gemini-2.5-flash', 'anthropic/claude-haiku-4.5'],
    });
  });

  it('fallbackChain は primary を先頭にして重複を除く', () => {
    expect(fallbackChain('google/gemini-2.5-flash', ['google/gemini-2.5-flash', 'anthropic/claude-haiku-4.5'])).toEqual(
      ['google/gemini-2.5-flash', 'anthropic/claude-haiku-4.5'],
    );
  });

  it('明示 fallback を持つ policy なら extra_body を付ける', () => {
    const body = chatBody(
      { slot: 'cron', model: 'a', fallbacks: ['a', 'b'], temperature: 0, failOpen: false },
      [{ role: 'user', content: 'x' }],
    );
    expect(body.extra_body).toEqual({ route: 'fallback', models: ['a', 'b'] });
  });

  it('fallback が空なら extra_body を付けない（C3 用）', () => {
    const body = chatBody(
      { slot: 'sensitive', model: 'fixed', fallbacks: [], temperature: 0, failOpen: false },
      [{ role: 'user', content: 'x' }],
    );
    expect(body.extra_body).toBeUndefined();
  });
});

describe('chatCompletion の失敗理由（ADR-0005 §10: 5xx / 429 / timeout / invalid_format）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('429 は reason=429', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('slow down', { status: 429 }));
    const got = await chatCompletion('key', [{ role: 'user', content: 'x' }], ORCA_POLICY.C1);
    expect(got).toMatchObject({ ok: false, status: 429, reason: '429' });
  });

  it('5xx は reason=5xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 503 }));
    const got = await chatCompletion('key', [{ role: 'user', content: 'x' }], ORCA_POLICY.C1);
    expect(got).toMatchObject({ ok: false, status: 503, reason: '5xx' });
  });

  it('ネットワーク例外（AbortSignal 含む）は reason=timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const got = await chatCompletion('key', [{ role: 'user', content: 'x' }], ORCA_POLICY.C1);
    expect(got).toMatchObject({ ok: false, status: 504, reason: 'timeout' });
  });

  it('本文が空 JSON なら reason=invalid_format', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 }),
    );
    const got = await chatCompletion('key', [{ role: 'user', content: 'x' }], ORCA_POLICY.C1);
    expect(got).toMatchObject({ ok: false, status: 502, reason: 'invalid_format' });
  });

  it('スキーマに合わない応答も reason=invalid_format', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not json', { status: 200 }));
    const got = await chatCompletion('key', [{ role: 'user', content: 'x' }], ORCA_POLICY.C1);
    expect(got).toMatchObject({ ok: false, status: 502, reason: 'invalid_format' });
  });

  it('成功時は tokensIn / tokensOut を usage から分けて持つ', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          model: 'gpt',
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }),
        { status: 200 },
      ),
    );
    const got = await chatCompletion('key', [{ role: 'user', content: 'x' }], ORCA_POLICY.C1);
    expect(got).toMatchObject({ ok: true, tokensIn: 10, tokensOut: 4, tokens: 14 });
  });
});
