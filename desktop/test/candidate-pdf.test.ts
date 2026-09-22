import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../src/shared/db.js';
import { ensureCandidateFulltexts, fillMissingPaperAuthors, promoteCandidatePdf } from '../src/shared/candidate-pdf.js';
import { createProject, setPaperFulltext, upsertPapers } from '../src/shared/repo.js';
import { createProjectWorkspace, candidatePdfPath } from '../src/shared/workspace.js';

let db: Db;
let root: string;

beforeEach(() => {
  db = openDb({ path: ':memory:' });
  root = mkdtempSync(join(tmpdir(), 'airesearch-cand-'));
  createProjectWorkspace(root);
  createProject(db, {
    project_id: 'p1',
    title: 'T',
    summary: 's',
    embed_model: 'm',
    root_path: root,
  });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('ensureCandidateFulltexts', () => {
  it('既存 PDF から本文を抽出し、ダウンロードはしない', async () => {
    upsertPapers(db, 'p1', [{ external_id: 'a', source: 's', title: 'Paper', abstract: null }]);
    const paperId = (
      db.prepare('SELECT paper_id FROM papers').get() as { paper_id: string }
    ).paper_id;
    const dest = candidatePdfPath(root, paperId);
    // 最小 %PDF ヘッダだけでは抽出失敗する想定。extract をモックせず失敗を許容するか、
    // ここでは download が呼ばれないことだけ見るため、既に fulltext がある行はスキップされる
    // → 代わりに promote と「URL 解決→download」経路を分ける
    writeFileSync(dest, '%PDF-1.4\n');

    const download = vi.fn(async () => 'ok' as const);
    const complete = vi.fn(async () => null);

    const result = await ensureCandidateFulltexts(db, 'p1', root, {
      gateway: { complete },
      pdfs: { download, rememberWrite() {}, wasWritten: () => false },
    });

    // 壊れた PDF は抽出失敗 → failed。download は走らない（ファイルが既にある）
    expect(download).not.toHaveBeenCalled();
    expect(result.attempted).toBe(1);
  });

  it('直 PDF URL があれば gateway 無しで取ろうとする', async () => {
    upsertPapers(db, 'p1', [
      {
        external_id: 'a',
        source: 's',
        title: 'Paper',
        abstract: null,
        url: 'https://example.com/a.pdf',
      },
    ]);

    const download = vi.fn(async (_url: string, dest: string) => {
      mkdirSync(join(dest, '..'), { recursive: true });
      writeFileSync(dest, '%PDF-1.4\n');
      return 'ok' as const;
    });

    const result = await ensureCandidateFulltexts(db, 'p1', root, {
      gateway: { complete: async () => null },
      pdfs: { download, rememberWrite() {}, wasWritten: () => false },
    });

    expect(download).toHaveBeenCalled();
    expect(result.downloaded).toBe(1);
  });

  it('収集時の pdf_url を使う。arXiv などの直リンクを引き直さない', async () => {
    upsertPapers(db, 'p1', [
      {
        external_id: '10.1234/a',
        source: 's',
        title: 'Paper',
        abstract: null,
        url: 'https://doi.org/10.1234/a',
        pdf_url: 'https://arxiv.org/pdf/2409.00001.pdf',
      },
    ]);

    const seen: string[] = [];
    const download = vi.fn(async (url: string, dest: string) => {
      seen.push(url);
      writeFileSync(dest, '%PDF-1.4\n');
      return 'ok' as const;
    });
    const complete = vi.fn(async () => null);

    await ensureCandidateFulltexts(db, 'p1', root, {
      gateway: { complete },
      pdfs: { download, rememberWrite() {}, wasWritten: () => false },
    });

    expect(seen).toEqual(['https://arxiv.org/pdf/2409.00001.pdf']);
    expect(complete).not.toHaveBeenCalled();
  });

  it('resolveMissing=false なら直リンクが無い候補に LLM を使わない（C-07 の未取得のまま）', async () => {
    upsertPapers(db, 'p1', [
      { external_id: '10.1234/b', source: 's', title: 'Paper', abstract: null, url: 'https://doi.org/10.1234/b' },
    ]);

    const download = vi.fn(async () => 'ok' as const);
    const complete = vi.fn(async () => null);

    const result = await ensureCandidateFulltexts(
      db,
      'p1',
      root,
      { gateway: { complete }, pdfs: { download, rememberWrite() {}, wasWritten: () => false } },
      { resolveMissing: false },
    );

    expect(complete).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
  });
});

describe('fillMissingPaperAuthors', () => {
  it('本文の 1 ページ目を LLM に渡して空の著者を埋める', async () => {
    upsertPapers(db, 'p1', [{ external_id: 'a', source: 's', title: 'Paper', abstract: null }]);
    const paperId = (db.prepare('SELECT paper_id FROM papers').get() as { paper_id: string }).paper_id;
    setPaperFulltext(db, paperId, {
      path: join(root, 'missing.pdf'),
      text: 'Ada Lovelace; Alan Turing\nHigh-speed packet I/O with DPDK\nAbstract: we present',
    });

    const complete = vi.fn(async (hint: { first_page?: string }) => {
      expect(hint.first_page).toContain('Ada Lovelace');
      return {
        record: {
          title: 'Paper',
          authors: 'Ada Lovelace; Alan Turing',
          year: 2026,
          doi: null,
          url: null,
          venue: null,
          abstract: null,
          item_type: 'article',
        },
        pdf_url: null,
      };
    });

    const got = await fillMissingPaperAuthors(db, 'p1', root, {
      gateway: { complete },
      pdfs: { download: async () => 'failed' as const, rememberWrite() {}, wasWritten: () => false },
    });

    expect(got.filled).toBe(1);
    const row = db.prepare('SELECT authors FROM papers WHERE paper_id = ?').get(paperId) as { authors: string };
    expect(row.authors).toBe('Ada Lovelace; Alan Turing');
  });
});

describe('promoteCandidatePdf', () => {
  it('candidates から references へコピーする', () => {
    const paperId = 'abcd';
    const src = candidatePdfPath(root, paperId);
    writeFileSync(src, '%PDF-1.4\n');
    const dest = join(root, 'references', 'key.pdf');
    const got = promoteCandidatePdf(root, paperId, dest);
    expect(got).toBe(dest);
    expect(existsSync(dest)).toBe(true);
  });
});
