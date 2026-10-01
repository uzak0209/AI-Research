import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { circuitBreakerThreshold } from '../src/collect/domain';
import { kvCircuitBreaker } from '../src/collect/infrastructure/adapters';
import { ingestCollect } from '../src/collect/application/ingest';
import type { IngestDeps } from '../src/collect/application/ports';

describe('circuitBreakerThreshold（ADR-0005 §7）', () => {
  it('設定値をそのまま使う', () => {
    expect(circuitBreakerThreshold('3')).toBe(3);
  });

  it('壊れていたら 1 = 最初の失敗で止める（fail closed）', () => {
    expect(circuitBreakerThreshold(undefined)).toBe(1);
    expect(circuitBreakerThreshold('')).toBe(1);
    expect(circuitBreakerThreshold('nope')).toBe(1);
    expect(circuitBreakerThreshold('0')).toBe(1);
    expect(circuitBreakerThreshold('-1')).toBe(1);
  });
});

describe('kvCircuitBreaker（KV 実装）', () => {
  it('閾値未満は閉じたまま。閾値に達すると開く', async () => {
    const breaker = kvCircuitBreaker(env.IDEMPOTENCY, 2);
    const scope = 'p-kv-1:2026-09-20';

    expect(await breaker.isOpen(scope)).toBe(false);
    await breaker.recordFailure(scope);
    expect(await breaker.isOpen(scope)).toBe(false);
    await breaker.recordFailure(scope);
    expect(await breaker.isOpen(scope)).toBe(true);
  });

  it('成功で連続失敗カウントをリセットする', async () => {
    const breaker = kvCircuitBreaker(env.IDEMPOTENCY, 2);
    const scope = 'p-kv-2:2026-09-20';

    await breaker.recordFailure(scope);
    await breaker.recordSuccess(scope);
    await breaker.recordFailure(scope);
    expect(await breaker.isOpen(scope)).toBe(false);
  });

  it('scope ごとに独立している（project をまたがない）', async () => {
    const breaker = kvCircuitBreaker(env.IDEMPOTENCY, 1);
    await breaker.recordFailure('p-kv-3:2026-09-20');
    expect(await breaker.isOpen('p-kv-3:2026-09-20')).toBe(true);
    expect(await breaker.isOpen('p-kv-4:2026-09-20')).toBe(false);
  });
});

describe('ingestCollect のサーキットブレーカー統合', () => {
  const MSG = {
    run_id: 'proj-breaker:2026-09-21',
    project_id: 'proj-breaker',
    summary: 'DPDK latency',
    source: 'openalex',
    run_date: '2026-09-21',
    user_id: 'u1',
  };

  function baseDeps(overrides: Partial<IngestDeps> = {}) {
    const saved: unknown[] = [];
    const stats = { searchCalls: 0, reviewCalls: 0 };
    const deps: IngestDeps = {
      papers: { fetch: async () => [] },
      runs: {
        knownExternalIds: async () => new Set(),
        save: async (...args) => {
          saved.push(args);
        },
      },
      search: {
        build: async () => {
          stats.searchCalls += 1;
          return { query: 'DPDK', queries: ['DPDK'], generated: false, usage: null, combo: ['DPDK'] };
        },
      },
      problemExcerpt: {
        attach: async (papers) => {
          stats.reviewCalls += 1;
          return { papers, usage: null };
        },
      },
      usage: {
        recordSearch: async () => {},
        recordReview: async () => {},
        recordTrend: async () => {},
      },
      trend: {
        analyze: async () => ({ report: { trend: null, themes: [] }, usage: null }),
      },
      breaker: {
        isOpen: async () => false,
        recordFailure: async () => {},
        recordSuccess: async () => {},
      },
      ...overrides,
    };
    return { deps, saved, stats };
  }

  it('開いていれば Named Router を一切呼ばず、failed として残す', async () => {
    const { deps, saved, stats } = baseDeps({
      breaker: { isOpen: async () => true, recordFailure: async () => {}, recordSuccess: async () => {} },
    });

    await expect(ingestCollect(deps, MSG)).rejects.toThrow();

    expect(stats.searchCalls).toBe(0);
    expect(stats.reviewCalls).toBe(0);
    expect(saved).toHaveLength(1);
    const [, papers, failure] = saved[0] as [unknown, unknown[], string | null];
    expect(papers).toEqual([]);
    expect(failure).toBeTruthy();
  });

  it('失敗すると breaker.recordFailure を呼ぶ', async () => {
    const calls: string[] = [];
    const { deps } = baseDeps({
      papers: {
        fetch: async () => {
          throw new Error('openalex down');
        },
      },
      breaker: {
        isOpen: async () => false,
        recordFailure: async (scope) => void calls.push(`fail:${scope}`),
        recordSuccess: async (scope) => void calls.push(`ok:${scope}`),
      },
    });

    await expect(ingestCollect(deps, MSG)).rejects.toThrow();
    expect(calls).toEqual(['fail:proj-breaker:2026-09-21']);
  });

  it('成功すると breaker.recordSuccess を呼ぶ', async () => {
    const calls: string[] = [];
    const { deps } = baseDeps({
      breaker: {
        isOpen: async () => false,
        recordFailure: async (scope) => void calls.push(`fail:${scope}`),
        recordSuccess: async (scope) => void calls.push(`ok:${scope}`),
      },
    });

    await ingestCollect(deps, MSG);
    expect(calls).toEqual(['ok:proj-breaker:2026-09-21']);
  });
});
