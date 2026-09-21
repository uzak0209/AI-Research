import { describe, expect, it } from 'vitest';
import { parseProblemExcerpts } from '../src/queries';

describe('parseProblemExcerpts（C-07: 捏造しない）', () => {
  const ids = new Set(['a', 'b']);

  it('external_id ごとの引用を取る', () => {
    const map = parseProblemExcerpts(
      '{"a":"Existing methods fail on large graphs.","b":null}',
      ids,
    );
    expect(map.get('a')).toBe('Existing methods fail on large graphs.');
    expect(map.get('b')).toBeNull();
  });

  it('許可外のキーは無視する', () => {
    const map = parseProblemExcerpts('{"a":"quote","c":"other"}', ids);
    expect(map.get('a')).toBe('quote');
    expect(map.has('c')).toBe(false);
  });

  it('JSON でなければ全部 null', () => {
    const map = parseProblemExcerpts('not json', ids);
    expect(map.get('a')).toBeNull();
    expect(map.get('b')).toBeNull();
  });

  it('配列は全部 null', () => {
    const map = parseProblemExcerpts('["a"]', ids);
    expect(map.get('a')).toBeNull();
  });
});
