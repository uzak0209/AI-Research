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
