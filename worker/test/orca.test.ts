import { describe, expect, it } from 'vitest';
import { chatBody, orcaKey } from '../src/orca';
import { collectPolicy, reviewPolicy, DEFAULT_COLLECT_ROUTER, DEFAULT_REVIEW_ROUTER } from '../src/orca-policy';
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

  it('受け皿は Named Router 側の設定に置くので extra_body を付けない', () => {
    const body = chatBody(reviewPolicy({} as Env), [{ role: 'user', content: 'x' }]);
    expect(body.model).toBe(DEFAULT_REVIEW_ROUTER);
    expect(body.temperature).toBe(0);
    expect(body.extra_body).toBeUndefined();
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
