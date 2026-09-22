import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/shared/db.js';
import {
  createProject,
  listPapersForRun,
  listSurveyReports,
  reportsMissingTrend,
  upsertPapers,
  upsertSurveyReport,
} from '../src/shared/repo.js';

let db: Db;
const PROJ = 'proj-report';

beforeEach(() => {
  db = openDb({ path: ':memory:' });
  createProject(db, {
    project_id: PROJ,
    title: 'Title',
    summary: 'DPDK latency',
    embed_model: 'Xenova/bge-small-en-v1.5',
  });
});

describe('survey_reports', () => {
  it('報告を upsert し、論文件数と紐づける', () => {
    upsertPapers(db, PROJ, [
      {
        external_id: 'x1',
        source: 'openalex',
        title: 'Paper one',
        authors: 'Ada',
        abstract: 'abs',
        url: null,
        published_at: '2026-01-01',
        coarse_score: 0.5,
        problem_excerpt: null,
        run_id: 'run-1',
      },
    ]);
    upsertSurveyReport(db, {
      run_id: 'run-1',
      project_id: PROJ,
      run_date: '2026-01-01',
      status: 'ok',
      search_terms: ['DPDK', 'XDP'],
      trend: '高速経路の研究が増えている',
      themes: ['NIC offload', 'eBPF'],
      created_at: '2026-01-01T00:00:00Z',
    });

    const reports = listSurveyReports(db, PROJ);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.run_date).toBe('2026-01-01');
    expect(reports[0]?.trend).toContain('高速経路');
    expect(reports[0]?.paper_count).toBe(1);
    expect(JSON.parse(reports[0]?.themes_json ?? '[]')).toEqual(['NIC offload', 'eBPF']);
    expect(listPapersForRun(db, PROJ, 'run-1')[0]?.title).toBe('Paper one');
  });

  it('trend が空で論文がある報告だけ missing に出す', () => {
    upsertPapers(db, PROJ, [
      {
        external_id: 'x1',
        source: 'openalex',
        title: 'Paper one',
        authors: null,
        abstract: null,
        url: null,
        published_at: null,
        coarse_score: null,
        problem_excerpt: null,
        run_id: 'run-empty-trend',
      },
    ]);
    upsertSurveyReport(db, {
      run_id: 'run-empty-trend',
      project_id: PROJ,
      run_date: '2026-01-02',
      status: 'ok',
      created_at: '2026-01-02T00:00:00Z',
    });
    upsertSurveyReport(db, {
      run_id: 'run-no-papers',
      project_id: PROJ,
      run_date: '2026-01-03',
      status: 'empty',
      created_at: '2026-01-03T00:00:00Z',
    });

    const missing = reportsMissingTrend(db, PROJ);
    expect(missing.map((r) => r.run_id)).toEqual(['run-empty-trend']);
  });

  it('後から来た trend で上書きし、空では消さない', () => {
    upsertSurveyReport(db, {
      run_id: 'run-1',
      project_id: PROJ,
      run_date: '2026-01-01',
      status: 'ok',
      trend: '初版',
      themes: ['A'],
      created_at: '2026-01-01T00:00:00Z',
    });
    upsertSurveyReport(db, {
      run_id: 'run-1',
      project_id: PROJ,
      run_date: '2026-01-01',
      status: 'ok',
      created_at: '2026-01-01T00:00:00Z',
    });
    expect(listSurveyReports(db, PROJ)[0]?.trend).toBe('初版');

    upsertSurveyReport(db, {
      run_id: 'run-1',
      project_id: PROJ,
      run_date: '2026-01-01',
      status: 'ok',
      trend: '更新',
      themes: ['B'],
      created_at: '2026-01-01T00:00:00Z',
    });
    expect(listSurveyReports(db, PROJ)[0]?.trend).toBe('更新');
    expect(JSON.parse(listSurveyReports(db, PROJ)[0]?.themes_json ?? '[]')).toEqual(['B']);
  });

  it('親プロジェクトが無い papers があっても openDb は落ちない', () => {
    const dir = mkdtempSync(join(tmpdir(), 'airesearch-orphan-'));
    const path = join(dir, 'app.db');
    try {
      let d = openDb({ path });
      d.exec('PRAGMA foreign_keys = OFF');
      d.exec(`
        INSERT INTO papers (paper_id, project_id, title, run_id, published_at)
        VALUES ('orphan', 'seed-demo', 'Seed leftover', 'seed-demo:2026-09-18', '2026-09-18')
      `);
      d.exec('PRAGMA foreign_keys = ON');
      d.close();

      expect(() => {
        d = openDb({ path });
      }).not.toThrow();
      const n = (d.prepare('SELECT COUNT(*) AS n FROM survey_reports').get() as { n: number }).n;
      expect(n).toBe(0);
      d.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('openDb 時に既存 papers.run_id から報告を埋める', () => {
    const dir = mkdtempSync(join(tmpdir(), 'airesearch-rep-'));
    const path = join(dir, 'app.db');
    try {
      let d = openDb({ path });
      createProject(d, {
        project_id: PROJ,
        title: 'Title',
        summary: 'DPDK latency',
        embed_model: 'Xenova/bge-small-en-v1.5',
      });
      upsertPapers(d, PROJ, [
        {
          external_id: 'x1',
          source: 'openalex',
          title: 'Old paper',
          authors: null,
          abstract: null,
          url: null,
          published_at: '2026-03-01',
          coarse_score: null,
          problem_excerpt: null,
          run_id: 'proj:2026-03-02',
        },
      ]);
      expect(listSurveyReports(d, PROJ)).toHaveLength(0);
      d.close();

      d = openDb({ path });
      const reports = listSurveyReports(d, PROJ);
      expect(reports).toHaveLength(1);
      expect(reports[0]?.run_id).toBe('proj:2026-03-02');
      expect(reports[0]?.paper_count).toBe(1);
      d.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
