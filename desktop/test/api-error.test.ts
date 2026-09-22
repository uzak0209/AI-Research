import { describe, expect, it } from 'vitest';
import { describeApiError, errorMessage } from '../src/shared/api-error.js';

describe('describeApiError', () => {
  it('detail の文字列を使う', () => {
    expect(describeApiError({ error: 'x', detail: '今日の利用上限に達した' }, 'fallback')).toBe(
      '今日の利用上限に達した',
    );
  });

  it('error がオブジェクトでも [object Object] にしない', () => {
    const body = {
      success: false,
      error: {
        name: 'ZodError',
        issues: [{ path: ['topic'], message: 'Too big: expected string to have <=2000 characters' }],
      },
    };
    expect(describeApiError(body, 'fallback')).toBe(
      'topic: Too big: expected string to have <=2000 characters',
    );
    expect(describeApiError(body, 'fallback')).not.toContain('[object Object]');
  });

  it('本文が無いときは fallback', () => {
    expect(describeApiError({ error: { issues: [] } }, '入力が不正です')).toBe('入力が不正です');
  });
});

describe('errorMessage', () => {
  it('IPC の飾りを外す', () => {
    expect(
      errorMessage(new Error("Error invoking remote method 'bff:keywords': Error: 今日の利用上限に達した")),
    ).toBe('今日の利用上限に達した');
  });

  it('[object Object] を出さない', () => {
    expect(errorMessage({ error: { foo: 1 } })).toBe('原因不明のエラー');
    expect(errorMessage('[object Object]')).toBe('原因不明のエラー');
  });
});
