import { describe, expect, it, vi } from 'vitest';
import {
  buildCollectBatch,
  enqueueManualCollect,
  scheduleCollect,
} from '../src/collect/application/schedule';
import type { ScheduleDeps } from '../src/collect/application/ports';

describe('buildCollectBatch', () => {
  it('プロジェクト × ソースぶんのメッセージを作る', () => {
    const msgs = buildCollectBatch(
      [{ project_id: 'p1', summary: 'DPDK', user_id: 'u1' }],
      { runDate: '2026-09-21', runIdFor: (p) => `${p.project_id}:2026-09-21` },
    );
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    expect(msgs[0]!.body.run_id).toBe('p1:2026-09-21');
    expect(msgs[0]!.body.summary).toBe('DPDK');
  });
});

describe('enqueueManualCollect', () => {
  it('手動 run_id で Queue に投入する', async () => {
    const sent: unknown[] = [];
    const deps = {
      clock: { today: () => '2026-09-21' },
      queue: { sendBatch: async (b: unknown[]) => void sent.push(...b) },
    };
    const got = await enqueueManualCollect(
      deps,
      { project_id: 'p1', summary: 'DPDK latency', user_id: 'u1' },
      1_700_000_000_000,
    );
    expect(got.run_id).toBe('p1:manual:1700000000000');
    expect(got.run_date).toBe('2026-09-21');
    expect(got.enqueued).toBe(sent.length);
    expect(sent.length).toBeGreaterThanOrEqual(1);
  });
});

describe('scheduleCollect', () => {
  it('cron 冪等キーがあると投入しない', async () => {
    const sent: unknown[] = [];
    const deps: ScheduleDeps = {
      clock: { today: () => '2026-09-21' },
      idempotency: { get: async () => '1', put: async () => {} },
      projects: { list: async () => [{ project_id: 'p1', summary: 'x', user_id: 'u1' }] },
      queue: { sendBatch: async (b: unknown[]) => void sent.push(...b) },
    };
    await scheduleCollect(deps);
    expect(sent).toHaveLength(0);
  });

  it('cron は project:date の run_id で投入する', async () => {
    const sent: { body: { run_id: string } }[] = [];
    const put = vi.fn(async () => {});
    const deps: ScheduleDeps = {
      clock: { today: () => '2026-09-21' },
      idempotency: { get: async () => null, put },
      projects: { list: async () => [{ project_id: 'p1', summary: 'x', user_id: 'u1' }] },
      queue: { sendBatch: async (b) => void sent.push(...(b as { body: { run_id: string } }[])) },
    };
    await scheduleCollect(deps);
    expect(sent[0]!.body.run_id).toBe('p1:2026-09-21');
    expect(put).toHaveBeenCalled();
  });
});
