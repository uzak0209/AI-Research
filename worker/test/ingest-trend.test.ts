import { describe, expect, it } from 'vitest';
import { ingestCollect } from '../src/collect/application/ingest';
import type { IngestDeps } from '../src/collect/application/ports';
import { parseTrendReport } from '../src/trend/domain';

const MSG = {
  run_id: 'proj:manual:1',
  project_id: 'proj',
  summary: 'DPDK latency',
  source: 'openalex',
  run_date: '2026-09-22',
  user_id: 'u1',
};

function paper(id: string) {
  return {
    external_id: id,
    title: `Paper ${id}`,
    authors: 'Ada',
    abstract: 'DPDK datapath',
    url: `https://example.test/${id}`,
    published_at: '2026-09-01',
  };
}

function deps(overrides: Partial<IngestDeps> = {}): IngestDeps & { saved: unknown[] } {
  const saved: unknown[] = [];
  const base: IngestDeps = {
    papers: {
      fetch: async () => [paper('W1'), paper('W2')],
    },
    runs: {
      knownExternalIds: async () => new Set(),
      save: async (...args) => {
        saved.push(args);
      },
    },
    search: {
      build: async () => ({
        query: 'DPDK',
        queries: ['DPDK'],
        generated: false,
        usage: null,
        combo: ['DPDK'],
      }),
    },
    problemExcerpt: {
      attach: async (papers) => ({ papers, usage: null }),
    },
    usage: {
      recordSearch: async () => {},
      recordReview: async () => {},
      recordTrend: async () => {},
    },
    trend: {
      analyze: async () => ({
        report: { trend: '高速経路が増えている', themes: ['XDP offload'] },
        usage: null,
      }),
    },
  };
  return { ...base, ...overrides, saved };
}

describe('ingestCollect の検索語', () => {
  it('メッセージの確定語を search.build に渡す', async () => {
    const seen: unknown[] = [];
    const d = deps({
      search: {
        build: async (summary, confirmed) => {
          seen.push({ summary, confirmed });
          return {
            query: 'DPDK',
            queries: ['DPDK'],
            generated: false,
            usage: null,
            combo: confirmed ? [...confirmed] : [],
          };
        },
      },
    });
    await ingestCollect(d, { ...MSG, search_terms: ['DPDK', 'XDP'] });
    expect(seen).toEqual([{ summary: 'DPDK latency', confirmed: ['DPDK', 'XDP'] }]);
  });
});

describe('parseTrendReport', () => {
  it('JSON から trend と themes を取る', () => {
    expect(
      parseTrendReport('{"trend":"高速経路","themes":["XDP","eBPF","XDP"]}'),
    ).toEqual({ trend: '高速経路', themes: ['XDP', 'eBPF'] });
  });

  it('フェンス付きでも取る', () => {
    const got = parseTrendReport('```json\n{"trend":"a","themes":["b"]}\n```');
    expect(got).toEqual({ trend: 'a', themes: ['b'] });
  });

  it('JSON でなければ本文だけ', () => {
    expect(parseTrendReport('ただの文章')).toEqual({ trend: 'ただの文章', themes: [] });
  });

  it('長さ上限で切れた JSON は拾えるだけ拾う。生の波括弧を見せない', () => {
    const got = parseTrendReport('{"trend": "提示された論文群は、クラウドの低レベ');
    expect(got.trend).toBe('提示された論文群は、クラウドの低レベ');
    expect(got.themes).toEqual([]);
  });

  it('切れた JSON でも themes が閉じていれば拾う', () => {
    const got = parseTrendReport('{"themes": ["XDP offload", "eBPF"], "trend": "高速経路が増え');
    expect(got.themes).toEqual(['XDP offload', 'eBPF']);
    expect(got.trend).toBe('高速経路が増え');
  });

  it('切れた位置がエスケープの途中でも落ちない', () => {
    expect(parseTrendReport('{"trend": "行が変わる\\').trend).toBe('行が変わる');
    expect(parseTrendReport('{"trend": "記号 \\u30').trend).toBe('記号');
  });

  it('波括弧で始まっても trend/themes が無ければ地の文として扱う', () => {
    expect(parseTrendReport('{これは JSON ではない').trend).toBe('{これは JSON ではない');
  });
});

describe('ingestCollect のトレンド', () => {
  it('集めた論文からトレンドを run に残す', async () => {
    const d = deps();
    await ingestCollect(d, MSG);
    expect(d.saved).toHaveLength(1);
    const report = (d.saved[0] as unknown[])[4];
    expect(report).toEqual({ trend: '高速経路が増えている', themes: ['XDP offload'] });
  });

  it('トレンド失敗でも論文は残す', async () => {
    const d = deps({
      trend: {
        analyze: async () => {
          throw new Error('orcarouter');
        },
      },
    });
    await ingestCollect(d, MSG);
    const papers = (d.saved[0] as unknown[])[1] as { title: string }[];
    const report = (d.saved[0] as unknown[])[4];
    expect(papers.length).toBeGreaterThan(0);
    expect(report).toEqual({ trend: null, themes: [] });
  });
});
