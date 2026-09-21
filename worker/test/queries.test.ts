import { describe, expect, it } from 'vitest';
import {
  COMBO_SIZE,
  MAX_INFERRED_ABBR,
  MIN_INFERRED_ABBR,
  collectSearchCombo,
  extractLatinTerms,
  isInferredAbbreviation,
  openAlexQueryFromSummary,
  openAlexQueryFromTerms,
  parseInferredAbbreviations,
  pickRandomSubset,
} from '../src/queries';

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

describe('collectSearchCombo', () => {
  it('summary の種語は毎回載せ、関連略語は乱択する', () => {
    const { combo, query } = collectSearchCombo(
      'dpdkによる高スループットの実現\nクラウドネイティブ\n\nDPDK',
      POOL,
      { rand: () => 0, comboSize: COMBO_SIZE },
    );
    expect(extractLatinTerms('dpdkによる高スループット\nDPDK').map((t) => t.toLowerCase())).toContain(
      'dpdk',
    );
    expect(combo.some((t) => t.toLowerCase() === 'dpdk')).toBe(true);
    expect(combo.length).toBe(1 + COMBO_SIZE);
    expect(query).toContain(' OR ');
  });

  it('乱択が変われば組み合わせも変わる', () => {
    const a = collectSearchCombo('DPDK', POOL.filter((t) => t !== 'DPDK'), { rand: () => 0 });
    const b = collectSearchCombo('DPDK', POOL.filter((t) => t !== 'DPDK'), { rand: () => 0.99 });
    expect(a.combo.slice(1)).not.toEqual(b.combo.slice(1));
  });
});

describe('pickRandomSubset', () => {
  it('n 件だけ返す', () => {
    expect(pickRandomSubset(['a', 'b', 'c', 'd'], 2, () => 0)).toHaveLength(2);
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
  it('略語は OR でつなぎ、訳語の空白句は載せない', () => {
    expect(openAlexQueryFromTerms(['high throughput', 'DPDK', 'eBPF'])).toBe('DPDK OR eBPF');
  });
});
