import { describe, expect, it } from 'vitest';
import { MAX_TERMS, parseTerms } from '../src/queries';

const SUMMARY = 'DPDK architecture for 100Gbps packet processing on commodity NICs';

describe('parseTerms（ADR-0005 §7: 入り口を無制限に広げさせない）', () => {
  it('summary の語彙と重なる検索語を採る', () => {
    const terms = parseTerms('["DPDK architecture", "packet processing"]', SUMMARY);
    expect(terms).toEqual(['DPDK architecture', 'packet processing']);
  });

  it('summary に無い話題へ広げた検索語は捨てる', () => {
    const terms = parseTerms('["DPDK architecture", "protein folding"]', SUMMARY);
    expect(terms).toEqual(['DPDK architecture']);
  });

  it('件数の上限で切る', () => {
    const many = JSON.stringify(
      Array.from({ length: MAX_TERMS + 4 }, (_, i) => `packet processing ${i}`),
    );
    expect(parseTerms(many, SUMMARY)).toHaveLength(MAX_TERMS);
  });

  it('重複は 1 つにまとめる', () => {
    const terms = parseTerms('["DPDK", "dpdk", "DPDK"]', SUMMARY);
    expect(terms).toEqual(['DPDK']);
  });

  it('JSON でなければ全部捨てる（部分的に直さない）', () => {
    expect(parseTerms('DPDK, packet processing', SUMMARY)).toEqual([]);
    expect(parseTerms('```json\n["DPDK"]\n```', SUMMARY)).toEqual([]);
  });

  it('配列でなければ捨てる', () => {
    expect(parseTerms('{"terms":["DPDK"]}', SUMMARY)).toEqual([]);
  });

  it('文字列以外の要素は無視する', () => {
    expect(parseTerms('[1, null, "DPDK"]', SUMMARY)).toEqual(['DPDK']);
  });
});
