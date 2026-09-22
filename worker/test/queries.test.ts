import { describe, expect, it } from 'vitest';
import {
  MAX_INFERRED_ABBR,
  MIN_INFERRED_ABBR,
  isInferredAbbreviation,
  isQueryAxisTerm,
  openAlexQueryFromTerms,
  parseInferredAbbreviations,
  parseSearchDecomposition,
  parseKeywordTags,
  mergeKeywordTags,
  parseSearchTermsJson,
  preciseSearchQueries,
  queriesFromConfirmedTerms,
  searchTermsFromConfirmed,
} from '../src/queries';
import { mergeLatestPapers, pickTopPapers } from '../src/collect/application/ingest';
import { COLLECT_DELIVER } from '../src/collect/application/search-terms';

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

describe('parseKeywordTags', () => {
  it('略語を残し、日本語と URL は捨てる', () => {
    expect(
      parseKeywordTags(JSON.stringify(['DPDK', 'ゼロコピー', 'https://example.com', 'RSS'])),
    ).toEqual(['DPDK', 'RSS']);
  });

  it('core を先に並べ、機能語は出さない', () => {
    expect(
      parseKeywordTags(
        JSON.stringify({ core: ['Transformer', 'self-attention'], related: ['The', 'of', 'ConvS2S'] }),
      ),
    ).toEqual(['Transformer', 'self-attention', 'ConvS2S']);
  });

  it('重複と長文は捨てる', () => {
    expect(
      parseKeywordTags(JSON.stringify(['DPDK', 'dpdk', 'これは長すぎてキーワードとして採用しない説明の文章である'])),
    ).toEqual(['DPDK']);
  });

  it('terms キーと前後の散文でも読む', () => {
    expect(parseKeywordTags('Here you go:\n{"terms":["DPDK","RSS"]}\n')).toEqual(['DPDK', 'RSS']);
  });
});

describe('mergeKeywordTags', () => {
  it('主題語を先に残す', () => {
    expect(mergeKeywordTags(['DPDK'], ['RSS', 'DPDK'])).toEqual(['DPDK', 'RSS']);
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
  it('主題語単独と主題語×各関連語の AND を全部並べる', () => {
    const qs = preciseSearchQueries(['DPDK'], ['DPDK', 'RSS', 'XDP', 'eBPF']);
    expect(qs[0]).toBe('DPDK');
    expect(qs).toContain('DPDK RSS');
    expect(qs).toContain('DPDK XDP');
    expect(qs).toContain('DPDK eBPF');
    expect(qs.some((q) => q.split(' ').length > 2)).toBe(false);
  });

  it('主題語は毎回載り、関連語の数だけ組み合わせが出る', () => {
    const qs = preciseSearchQueries(['DPDK'], POOL);
    expect(qs[0]).toBe('DPDK');
    expect(qs.length).toBeGreaterThan(MIN_INFERRED_ABBR - 1);
  });

  it('機能語は軸にしない。軸が無ければクエリを作らない（C-07）', () => {
    expect(preciseSearchQueries(['The'], ['RSS', 'XDP'])).toEqual([]);
    expect(preciseSearchQueries([], POOL)).toEqual([]);
  });
});

describe('isQueryAxisTerm', () => {
  it('機能語と一般語は軸にしない', () => {
    for (const t of ['The', 'of', 'goal', 'reducing', 'using', 'paper']) {
      expect(isQueryAxisTerm(t)).toBe(false);
    }
  });

  it('技術語・略語は軸になる', () => {
    for (const t of ['DPDK', 'eBPF', 'dpdk', 'IPv6']) {
      expect(isQueryAxisTerm(t)).toBe(true);
    }
  });

  it('空白を含む句は軸にしない（OpenAlex の AND が崩れる）', () => {
    expect(isQueryAxisTerm('packet I/O')).toBe(false);
  });
});

describe('parseSearchDecomposition', () => {
  it('core と related に分ける', () => {
    const got = parseSearchDecomposition(
      JSON.stringify({ core: ['DPDK'], related: ['RSS', 'XDP', 'eBPF'] }),
    );
    expect(got.core).toEqual(['DPDK']);
    expect(got.related).toEqual(['RSS', 'XDP', 'eBPF']);
  });

  it('core から機能語を落とす。LLM が The を返しても軸にしない', () => {
    const got = parseSearchDecomposition(
      JSON.stringify({ core: ['The', 'goal', 'DPDK'], related: ['RSS'] }),
    );
    expect(got.core).toEqual(['DPDK']);
  });

  it('フェンス付きでも読む。形が違えば形式不正扱いで空', () => {
    expect(parseSearchDecomposition('```json\n{"core":["DPDK"],"related":[]}\n```').core).toEqual(['DPDK']);
    expect(parseSearchDecomposition('not json')).toEqual({ core: [], related: [], ok: false });
    expect(parseSearchDecomposition('["DPDK"]')).toEqual({ core: [], related: [], ok: false });
  });
});

describe('parseSearchTermsJson', () => {
  it('JSON 配列だけ採る', () => {
    expect(parseSearchTermsJson('["DPDK","RSS"]')).toEqual(['DPDK', 'RSS']);
    expect(parseSearchTermsJson(null)).toEqual([]);
    expect(parseSearchTermsJson('not-json')).toEqual([]);
    expect(parseSearchTermsJson('{"a":1}')).toEqual([]);
  });
});

describe('pickTopPapers', () => {
  it('粗い一致を優先し、同点なら新しい順。件数は 5', () => {
    const base = {
      authors: null,
      abstract: null,
      url: null,
      problem_excerpt: null,
    };
    const got = pickTopPapers(
      [
        { ...base, external_id: 'old-high', title: 'old high', published_at: '2024-01-01', coarse_score: 0.9 },
        { ...base, external_id: 'new-low', title: 'new low', published_at: '2026-09-01', coarse_score: 0.1 },
        { ...base, external_id: 'new-high', title: 'new high', published_at: '2026-08-01', coarse_score: 0.9 },
        { ...base, external_id: 'mid-1', title: 'mid 1', published_at: '2025-01-01', coarse_score: 0.4 },
        { ...base, external_id: 'mid-2', title: 'mid 2', published_at: '2025-06-01', coarse_score: 0.4 },
        { ...base, external_id: 'mid-3', title: 'mid 3', published_at: '2025-03-01', coarse_score: 0.4 },
      ],
      COLLECT_DELIVER,
    );
    expect(got).toHaveLength(5);
    expect(got.map((p) => p.external_id)).toEqual([
      'new-high',
      'old-high',
      'mid-2',
      'mid-3',
      'mid-1',
    ]);
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

describe('queriesFromConfirmedTerms', () => {
  it('先頭を軸に、残りは AND する', () => {
    expect(queriesFromConfirmedTerms(['DPDK', 'XDP', 'RSS'])).toEqual([
      'DPDK XDP RSS',
      'DPDK',
      'DPDK XDP',
      'DPDK RSS',
    ]);
  });

  it('空白入りの術語もクエリにする', () => {
    expect(queriesFromConfirmedTerms(['zero-copy', 'DPDK'])).toEqual(['zero-copy DPDK', 'zero-copy']);
  });
});

describe('searchTermsFromConfirmed', () => {
  it('空なら null。LLM に落とす合図', () => {
    expect(searchTermsFromConfirmed([])).toBeNull();
    expect(searchTermsFromConfirmed(undefined)).toBeNull();
  });

  it('確定語があれば LLM を使った扱いにしない', () => {
    const got = searchTermsFromConfirmed(['DPDK', 'XDP']);
    expect(got?.generated).toBe(false);
    expect(got?.usage).toBeNull();
    expect(got?.combo).toEqual(['DPDK', 'XDP']);
  });
});

describe('openAlexQueryFromTerms', () => {
  it('略語は AND（空白）でつなぎ、訳語の空白句は載せない', () => {
    expect(openAlexQueryFromTerms(['high throughput', 'DPDK', 'eBPF'])).toBe('DPDK eBPF');
  });
});
