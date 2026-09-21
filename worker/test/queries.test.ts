import { describe, expect, it } from 'vitest';
import {
  MAX_INFERRED_ABBR,
  MIN_INFERRED_ABBR,
  extractLatinTerms,
  isInferredAbbreviation,
  openAlexQueryFromSummary,
  openAlexQueryFromTerms,
  parseInferredAbbreviations,
  preciseSearchQueries,
} from '../src/queries';
import { mergeLatestPapers } from '../src/collect/application/ingest';

const POOL = [
  'DPDK',
  'RSS',
  'XDP',
  'eBPF',
  'NFV',
  'VPP',
  'PMD',
  'NIC',
  'QEMU',
  'SR-IOV',
  'VFIO',
  'OVS',
  'AF_XDP',
  'kTLS',
  'IPv6',
  'VXLAN',
  'GENEVE',
  'DDoS',
  'QoS',
  'UPF',
  'CNI',
  'vSwitch',
];

describe('parseInferredAbbreviations', () => {
  it('略語 20 件以上を採る', () => {
    expect(POOL.length).toBeGreaterThanOrEqual(MIN_INFERRED_ABBR);
    const got = parseInferredAbbreviations(JSON.stringify(POOL));
    expect(got.length).toBeGreaterThanOrEqual(MIN_INFERRED_ABBR);
    expect(got).toContain('DPDK');
    expect(got).toContain('eBPF');
  });

  it('句・URL・他分野の普通名詞は捨てる', () => {
    const got = parseInferredAbbreviations(
      JSON.stringify(['DPDK', 'high throughput', 'https://example.com', 'protein', 'RSS']),
    );
    expect(got).toEqual(['DPDK', 'RSS']);
  });

  it('上限で切る', () => {
    const many = Array.from({ length: MAX_INFERRED_ABBR + 10 }, (_, i) => `AB${i}`);
    expect(parseInferredAbbreviations(JSON.stringify(many))).toHaveLength(MAX_INFERRED_ABBR);
  });

  it('JSON 配列でなければ捨てる', () => {
    expect(parseInferredAbbreviations('DPDK, RSS')).toEqual([]);
    expect(parseInferredAbbreviations('{"abbr":"DPDK"}')).toEqual([]);
  });
});

describe('isInferredAbbreviation', () => {
  it('大文字を 2 つ以上含む略語だけ', () => {
    expect(isInferredAbbreviation('DPDK')).toBe(true);
    expect(isInferredAbbreviation('eBPF')).toBe(true);
    expect(isInferredAbbreviation('IPv6')).toBe(true);
    expect(isInferredAbbreviation('protein')).toBe(false);
    expect(isInferredAbbreviation('cloud native')).toBe(false);
  });
});

describe('preciseSearchQueries', () => {
  it('種語単独と種語×各略語の AND を全部並べる', () => {
    const qs = preciseSearchQueries('DPDK', ['DPDK', 'RSS', 'XDP', 'eBPF']);
    expect(qs[0]).toBe('DPDK');
    expect(qs).toContain('DPDK RSS');
    expect(qs).toContain('DPDK XDP');
    expect(qs).toContain('DPDK eBPF');
    expect(qs.some((q) => q.split(' ').length > 2)).toBe(false);
  });

  it('summary の種語は毎回載る', () => {
    const seeds = extractLatinTerms('dpdkによる高スループットの実現\nDPDK');
    expect(seeds.map((t) => t.toLowerCase())).toContain('dpdk');
    const qs = preciseSearchQueries('dpdkによる高スループットの実現\nDPDK', POOL);
    expect(qs[0]?.toLowerCase()).toBe('dpdk');
    expect(qs.length).toBeGreaterThan(MIN_INFERRED_ABBR - 1);
  });
});

describe('mergeLatestPapers', () => {
  it('新しい順に通し、同じ ID は 1 件にする', () => {
    const got = mergeLatestPapers(
      [
        { external_id: 'a', title: 'old', authors: null, abstract: null, url: null, published_at: '2024-01-01' },
        { external_id: 'b', title: 'new', authors: null, abstract: null, url: null, published_at: '2026-09-01' },
        { external_id: 'a', title: 'dup', authors: null, abstract: null, url: null, published_at: '2025-01-01' },
      ],
      10,
    );
    expect(got.map((p) => p.external_id)).toEqual(['b', 'a']);
    expect(got[1]?.title).toBe('old');
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

describe('openAlexQueryFromTerms', () => {
  it('略語は AND（空白）でつなぎ、訳語の空白句は載せない', () => {
    expect(openAlexQueryFromTerms(['high throughput', 'DPDK', 'eBPF'])).toBe('DPDK eBPF');
  });
});
