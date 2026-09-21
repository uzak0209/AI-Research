import { describe, expect, it } from 'vitest';
import { chatBody, orcaKey } from '../src/shared/orca/chat';
import { ORCA_POLICY } from '../src/shared/orca/policy';
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

describe('chatBody', () => {
  it('C1 は fallback チェーンと temperature 0 を付ける', () => {
    const body = chatBody(ORCA_POLICY.C1, [{ role: 'user', content: 'x' }]);
    expect(body.model).toBe('openai/gpt-4o-mini');
    expect(body.temperature).toBe(0);
    expect(body.extra_body).toEqual({
      route: 'fallback',
      models: [...ORCA_POLICY.C1.fallbacks],
    });
  });

  it('fallback が空なら extra_body を付けない（C3 用）', () => {
    const body = chatBody(
      { slot: 'sensitive', model: 'fixed', fallbacks: [], temperature: 0, failOpen: false },
      [{ role: 'user', content: 'x' }],
    );
    expect(body.extra_body).toBeUndefined();
  });
});
