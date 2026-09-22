import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudClient } from '@ai-research/core';
import { openDb, type Db } from '../src/shared/db.js';
import { createProject, countUnscored, getProject, listSurveyReports, parseSearchTerms, setManuscript } from '../src/shared/repo.js';
import { cloudSummaryFromLocal, syncProjectFromCloud } from '../src/shared/sync.js';

let db: Db;
const PROJ = 'proj-sync';

function mockClient(handlers: {
  putProject?: CloudClient['putProject'];
  pullRuns?: CloudClient['pullRuns'];
}): CloudClient {
  return {
    putProject:
      handlers.putProject ??
      vi.fn(async () => ({ project_id: PROJ, title: 'T', summary: 'S' })),
    pullRuns:
      handlers.pullRuns ??
      vi.fn(async () => ({ project_id: PROJ, runs: [] })),
  } as unknown as CloudClient;
}

beforeEach(() => {
  db = openDb({ path: ':memory:' });
  createProject(db, {
    project_id: PROJ,
    title: 'Title',
    summary: 'Summary text',
    embed_model: 'Xenova/bge-small-en-v1.5',
  });
});

describe('cloudSummaryFromLocal', () => {
  it('関連技術が無ければ課題意識だけ', () => {
    expect(cloudSummaryFromLocal('problem', [])).toBe('problem');
  });

  it('課題意識と関連技術を連結する', () => {
    expect(cloudSummaryFromLocal('problem', [{ text: 'DPDK' }, { text: 'NIC' }])).toBe(
      'problem\n\nDPDK\nNIC',
    );
  });
});

describe('syncProjectFromCloud', () => {
  it('存在しない projectId なら throw', async () => {
    await expect(syncProjectFromCloud(db, mockClient({}), 'missing')).rejects.toThrow(/not found/);
  });

  it('pull した run の papers を upsert し last_run_id を進める', async () => {
    setManuscript(db, PROJ, [{ text: 'DPDK' }, { text: 'RSS' }]);
    const putProject = vi.fn(async () => ({
      project_id: PROJ,
      title: 'Title',
      summary: 'Summary text\n\nDPDK\nRSS',
    }));
    const pullRuns = vi.fn(async (_id: string, after?: string | null) => {
      expect(after).toBeNull();
      return {
        project_id: PROJ,
        runs: [
          {
            run_id: 'run-1',
            run_date: '2026-01-01',
            status: 'ok',
            failed_sources_json: null,
            search_terms: ['DPDK', 'RSS', 'XDP'],
            trend: 'DPDK の高速経路が増えている',
            themes: ['XDP offload'],
            created_at: '2026-01-01T00:00:00Z',
            papers: [
              {
                external_id: 'x1',
                source: 'openalex',
                title: 'Paper one',
                authors: 'Ada Lovelace',
                abstract: 'ab',
                url: null,
                published_at: null,
                pdf_url: 'https://arxiv.org/pdf/2409.00001.pdf',
                coarse_score: 0.5,
                problem_excerpt: 'problem here',
              },
            ],
          },
          {
            run_id: 'run-2',
            run_date: '2026-01-02',
            status: 'ok',
            failed_sources_json: null,
            created_at: '2026-01-02T00:00:00Z',
            papers: [],
          },
        ],
      };
    });

    const { inserted, lastRunId } = await syncProjectFromCloud(
      db,
      mockClient({ putProject, pullRuns }),
      PROJ,
    );

    expect(putProject).toHaveBeenCalledWith(PROJ, {
      title: 'Title',
      summary: 'Summary text\n\nDPDK\nRSS',
    });
    expect(inserted).toBe(1);
    expect(lastRunId).toBe('run-2');
    expect(getProject(db, PROJ)?.last_run_id).toBe('run-2');
    expect(parseSearchTerms(getProject(db, PROJ)?.last_search_terms)).toEqual(['DPDK', 'RSS', 'XDP']);
    expect(countUnscored(db, PROJ)).toBe(1);

    const reports = listSurveyReports(db, PROJ);
    expect(reports).toHaveLength(2);
    expect(reports.find((r) => r.run_id === 'run-1')?.trend).toContain('DPDK');
    expect(JSON.parse(reports.find((r) => r.run_id === 'run-1')?.themes_json ?? '[]')).toEqual(['XDP offload']);
    expect(reports.find((r) => r.run_id === 'run-2')?.paper_count).toBe(0);

    const row = db
      .prepare('SELECT problem_excerpt, authors, pdf_url FROM papers WHERE project_id = ?')
      .get(PROJ) as { problem_excerpt: string; authors: string; pdf_url: string };
    expect(row.problem_excerpt).toBe('problem here');
    expect(row.authors).toBe('Ada Lovelace');
    // 収集時に取れた直 PDF はそのまま手元へ。取得はデスクトップ（ADR-0003）
    expect(row.pdf_url).toBe('https://arxiv.org/pdf/2409.00001.pdf');
  });

  it('after は last_run_id を渡す', async () => {
    db.prepare('UPDATE projects SET last_run_id = ? WHERE project_id = ?').run('run-old', PROJ);
    const pullRuns = vi.fn(async (_id: string, after?: string | null) => {
      expect(after).toBe('run-old');
      return { project_id: PROJ, runs: [] };
    });
    await syncProjectFromCloud(db, mockClient({ pullRuns }), PROJ);
  });
});
