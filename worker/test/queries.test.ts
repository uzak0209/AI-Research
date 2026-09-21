import { describe, expect, it } from 'vitest';
import {
  MAX_TERMS,
  needsEnglishSearchTerms,
  openAlexQueryFromSummary,
  parseTermPairs,
  parseTerms,
} from '../src/queries';

const SUMMARY = 'DPDK architecture for 100Gbps packet processing on commodity NICs';

function pairs(json: string, summary = SUMMARY) {
  return parseTermPairs(json, summary);
}

describe('parseTermPairs（抽出→英訳。source は summary 字面）', () => {
  it('source が summary にある対の en を採る', () => {
    const got = pairs(
      JSON.stringify([
        { source: 'DPDK architecture', en: 'DPDK architecture' },
        { source: 'packet processing', en: 'packet processing' },
      ]),
    );
    expect(got.map((p) => p.en)).toEqual(['DPDK architecture', 'packet processing']);
  });

  it('summary に無い source は捨てる', () => {
    const got = pairs(
      JSON.stringify([
        { source: 'DPDK architecture', en: 'DPDK architecture' },
        { source: 'protein folding', en: 'protein folding' },
      ]),
    );
    expect(got.map((p) => p.en)).toEqual(['DPDK architecture']);
  });

  it('ラテン source に無関係な en は捨てる', () => {
    const got = pairs(JSON.stringify([{ source: 'DPDK', en: 'protein folding' }]));
    expect(got).toEqual([]);
  });

  it('件数の上限で切る', () => {
    const many = Array.from({ length: MAX_TERMS + 4 }, (_, i) => ({
      source: 'packet processing',
      en: `packet processing ${i}`,
    }));
    // source は同じでも en が違う。faithful は packet を含むので通るが上限で切る
    expect(pairs(JSON.stringify(many))).toHaveLength(MAX_TERMS);
  });

  it('en の重複は 1 つにまとめる', () => {
    const got = pairs(
      JSON.stringify([
        { source: 'DPDK', en: 'DPDK' },
        { source: 'DPDK', en: 'dpdk' },
      ]),
    );
    expect(got.map((p) => p.en)).toEqual(['DPDK']);
  });

  it('JSON でなければ全部捨てる', () => {
    expect(pairs('DPDK, packet processing')).toEqual([]);
    expect(pairs('```json\n[{"source":"DPDK","en":"DPDK"}]\n```')).toEqual([]);
  });

  it('配列でなければ捨てる', () => {
    expect(pairs('{"source":"DPDK","en":"DPDK"}')).toEqual([]);
  });

  it('日本語から抽出した語の英訳を採る', () => {
    const ja = 'dpdkによる高スループットの実現\nクラウドネイティブ';
    expect(needsEnglishSearchTerms(ja)).toBe(true);
    const got = parseTerms(
      JSON.stringify([
        { source: '高スループット', en: 'high throughput' },
        { source: 'クラウドネイティブ', en: 'cloud native' },
        { source: 'dpdk', en: 'DPDK' },
      ]),
      ja,
    );
    expect(got).toEqual(['high throughput', 'cloud native', 'DPDK']);
  });

  it('日本語 source が summary に無い英訳は捨てる', () => {
    const ja = 'dpdkによる高スループットの実現';
    expect(
      parseTerms(JSON.stringify([{ source: 'タンパク質折りたたみ', en: 'protein folding' }]), ja),
    ).toEqual([]);
  });
});

describe('openAlexQueryFromSummary', () => {
  it('フォールバックはラテン種語だけ', () => {
    const q = openAlexQueryFromSummary('dpdkによる高スループットの実現\nクラウドネイティブ\n\nDPDK');
    expect(q.toLowerCase()).toContain('dpdk');
    expect(q).not.toMatch(/スループット|クラウド/);
  });

  it('ラテンが無ければ空', () => {
    expect(openAlexQueryFromSummary('高スループット\n実現')).toBe('');
  });
});
