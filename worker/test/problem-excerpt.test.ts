import { describe, expect, it } from 'vitest';
import { parseProblemExcerpts } from '../src/queries';

describe('parseProblemExcerpts（C-07: 捏造しない）', () => {
  const ids = new Set(['a', 'b']);

  it('external_id ごとの引用を取る', () => {
    const { ok, excerpts } = parseProblemExcerpts(
      '{"a":"Existing methods fail on large graphs.","b":null}',
      ids,
    );
    expect(ok).toBe(true);
    expect(excerpts.get('a')).toBe('Existing methods fail on large graphs.');
    expect(excerpts.get('b')).toBeNull();
  });

  it('許可外のキーは無視する', () => {
    const { excerpts } = parseProblemExcerpts('{"a":"quote","c":"other"}', ids);
    expect(excerpts.get('a')).toBe('quote');
    expect(excerpts.has('c')).toBe(false);
  });

  it('JSON でなければ形式不正。全部 null', () => {
    const { ok, excerpts } = parseProblemExcerpts('not json', ids);
    expect(ok).toBe(false);
    expect(excerpts.get('a')).toBeNull();
    expect(excerpts.get('b')).toBeNull();
  });

  it('配列は形式不正。全部 null', () => {
    const { ok, excerpts } = parseProblemExcerpts('["a"]', ids);
    expect(ok).toBe(false);
    expect(excerpts.get('a')).toBeNull();
  });
});
