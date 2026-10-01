import { describe, expect, it } from 'vitest';
import { parseProblemExcerpts } from '../src/queries';
import { verifyProblemExcerpt } from '../src/collect/application/problem-excerpt';

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

describe('verifyProblemExcerpt（ADR-0005 §10・FR-16: 捏造検知）', () => {
  it('abstract に逐語で含まれていれば true', () => {
    expect(
      verifyProblemExcerpt('existing methods fail on large graphs', 'We show that existing methods fail on large graphs, which limits adoption.'),
    ).toBe(true);
  });

  it('空白の連続や大小文字の違いは無視する', () => {
    expect(verifyProblemExcerpt('Existing   methods FAIL', 'existing methods fail on large graphs')).toBe(true);
  });

  it('abstract に無ければ false（捏造の疑い）', () => {
    expect(verifyProblemExcerpt('This claim is not in the abstract at all.', 'A short abstract about graphs.')).toBe(false);
  });

  it('excerpt が無ければ null（未実施と区別。C-07）', () => {
    expect(verifyProblemExcerpt(null, 'abstract text')).toBeNull();
  });

  it('excerpt はあるが abstract が無ければ false', () => {
    expect(verifyProblemExcerpt('some quote', null)).toBe(false);
  });
});
