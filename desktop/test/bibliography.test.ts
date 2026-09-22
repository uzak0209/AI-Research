import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NotSignedInError, type CloudClient } from '@ai-research/core';
import { followReference } from '../src/bibliography/application/follow-reference.js';
import { ingestPdf } from '../src/bibliography/application/ingest-pdf.js';
import type { BibliographyDeps, ReferenceRepo } from '../src/bibliography/application/ports.js';
import { doiFromExternalId } from '../src/bibliography/domain/doi.js';
import {
  BIB_BEGIN,
  BIB_END,
  hashInner,
  planSplice,
  renderBibtex,
  renderHayagriva,
} from '../src/bibliography/domain/cite-format.js';
import { httpsPdfUrl } from '../src/bibliography/domain/oa-url.js';
import { hintFromReference, isEmptyRecord, mergeRecord, type ReferenceSnapshot } from '../src/bibliography/domain/record.js';
import { candidatePdfPath } from '../src/shared/workspace.js';
import { bffBibliographyGateway, fsCiteFiles } from '../src/bibliography/infrastructure/adapters.js';
import { openDb } from '../src/shared/db.js';
import { createProject, setProjectRoot } from '../src/shared/repo.js';

function client(res: Response | Error): CloudClient {
  return {
    bibliography: vi.fn(async () => {
      if (res instanceof Error) throw res;
      return res;
    }),
  } as unknown as CloudClient;
}

const record = {
  title: 'GNN',
  authors: 'Ada',
  year: 2024,
  doi: '10.1234/foo',
  url: 'https://doi.org/10.1234/foo',
  venue: 'SIGCOMM',
  abstract: null,
  item_type: 'article',
};

function snapshot(over: Partial<ReferenceSnapshot> = {}): ReferenceSnapshot {
  return {
    reference_id: 'r1',
    title: 'GNN',
    authors: null,
    year: null,
    doi: '10.1234/foo',
    url: null,
    venue: null,
    abstract: null,
    item_type: 'article',
    bibtex_key: 'gnn2024',
    ...over,
  };
}

function memoryRepo(initial: ReferenceSnapshot[] = []): ReferenceRepo & { rows: Map<string, ReferenceSnapshot> } {
  const rows = new Map(initial.map((r) => [r.reference_id, r]));
  const attachments = new Map<string, { path: string }[]>();
  const byPath = new Map<string, string>();
  const byDoi = new Map<string, string>();
  for (const r of initial) {
    if (r.doi) byDoi.set(r.doi, r.reference_id);
  }
  return {
    rows,
    get: (id) => rows.get(id),
    list: () => [...rows.values()],
    add(_projectId, item) {
      const id = `r${rows.size + 1}`;
      const row = snapshot({
        reference_id: id,
        title: item.title,
        authors: item.authors ?? null,
        year: item.year ?? null,
        doi: item.doi ?? null,
        bibtex_key: `k${rows.size}`,
      });
      rows.set(id, row);
      if (item.doi) byDoi.set(item.doi, id);
      return id;
    },
    update(id, patch) {
      const cur = rows.get(id);
      if (cur) rows.set(id, { ...cur, ...patch });
    },
    addAttachment(id, path) {
      attachments.set(id, [...(attachments.get(id) ?? []), { path }]);
      byPath.set(path, id);
    },
    attachments: (id) => attachments.get(id) ?? [],
    findByDoi: (_p, doi) => byDoi.get(doi),
    findByPath: (path) => {
      const id = byPath.get(path);
      return id ? { reference_id: id } : undefined;
    },
    projectRoot: () => '/proj',
    paperId: () => null,
    citeItems: () =>
      [...rows.values()].map((r) => ({
        bibtex_key: r.bibtex_key,
        title: r.title,
        authors: r.authors,
        year: r.year,
        doi: r.doi,
        url: r.url,
        venue: r.venue,
        item_type: r.item_type,
      })),
  };
}

function deps(over: Partial<BibliographyDeps> & { refs?: ReferenceRepo } = {}): BibliographyDeps {
  return {
    refs: over.refs ?? memoryRepo([snapshot()]),
    gateway: {
      complete: async () => ({ record, pdf_url: 'https://arxiv.org/pdf/x.pdf' }),
    },
    pdfs: {
      download: async () => 'ok',
      rememberWrite() {},
      wasWritten: () => false,
    },
    cites: { exportAll: () => 'ok' },
    extract: {
      fromBytes: async () => ({
        title: 'From PDF',
        authors: 'Ada',
        year: 2024,
        doi: '10.1234/foo',
        firstPageText: 'Abstract',
        titleSource: 'info',
      }),
      firstPageFromPath: async () => 'page one',
    },
    paths: {
      resolve: (p) => p,
      basename: (p) => p.split('/').pop() ?? p,
      isPdf: (p) => p.toLowerCase().endsWith('.pdf'),
      oaDest: (root, key) => `${root}/references/${key}.pdf`,
    },
    ...over,
  };
}

describe('hintFromReference', () => {
  it('null は載せない。Worker の optional string が null を拒むため', () => {
    expect(
      hintFromReference({
        title: ' GNN ',
        authors: null,
        year: 2024,
        doi: ' 10.1234/foo ',
        url: null,
        venue: '',
        abstract: null,
      }),
    ).toEqual({ title: 'GNN', year: 2024, doi: '10.1234/foo' });
  });
});

describe('doiFromExternalId', () => {
  it('収集側と同じ正規化。DOI でなければ null', () => {
    expect(doiFromExternalId('https://doi.org/10.1234/foo')).toBe('10.1234/foo');
    expect(doiFromExternalId('10.1234/foo')).toBe('10.1234/foo');
    expect(doiFromExternalId('https://openalex.org/W1')).toBeNull();
  });
});

describe('httpsPdfUrl', () => {
  it('https の直リンクだけ通す', () => {
    expect(httpsPdfUrl('https://arxiv.org/pdf/a.pdf')).toBe('https://arxiv.org/pdf/a.pdf');
    expect(httpsPdfUrl('http://arxiv.org/pdf/a.pdf')).toBeNull();
    expect(httpsPdfUrl('https://ex.example/abs.html')).toBeNull();
  });
});

describe('mergeRecord', () => {
  it('空で既存を消さない', () => {
    const got = mergeRecord(snapshot({ title: 'Keep', authors: 'Ada' }), {
      ...record,
      title: null,
      authors: 'Bob',
    });
    expect(got.title).toBe('Keep');
    expect(got.authors).toBe('Bob');
  });
});

describe('cite markers (planSplice)', () => {
  it('初回はマーカーが無ければ末尾に足す', () => {
    const plan = planSplice('hello', '@article{a,}', BIB_BEGIN, BIB_END, null);
    expect(plan.status).toBe('create');
    if (plan.status === 'create' || plan.status === 'update') expect(plan.next).toContain(BIB_BEGIN);
  });

  it('マーカーが両方あり前回分と一致すれば再生成する', () => {
    const lastHash = hashInner('old');
    const plan = planSplice(`${BIB_BEGIN}\nold\n${BIB_END}\n`, '@article{a,}', BIB_BEGIN, BIB_END, lastHash);
    expect(plan.status).toBe('update');
    if (plan.status === 'create' || plan.status === 'update') expect(plan.next).toContain('@article{a,}');
  });

  it('片方だけなら触らない（C-08）', () => {
    expect(planSplice(BIB_BEGIN, 'x', BIB_BEGIN, BIB_END, null).status).toBe('skip_broken');
  });

  it('マーカーが消され、前回書き出し記録があれば復元しない（C-08 却下事項）', () => {
    const lastHash = hashInner('old');
    expect(planSplice('hello（マーカーなし）', 'x', BIB_BEGIN, BIB_END, lastHash).status).toBe('skip_removed');
  });

  it('マーカー内が前回書き出し分と食い違えば手編集とみなし上書きしない（C-08）', () => {
    const lastHash = hashInner('old');
    const edited = `${BIB_BEGIN}\nold\n手で足した行\n${BIB_END}\n`;
    expect(planSplice(edited, '@article{a,}', BIB_BEGIN, BIB_END, lastHash).status).toBe('skip_conflict');
  });

  it('BibTeX と Hayagriva を出す', () => {
    const item = {
      bibtex_key: 'ada2024',
      title: 'GNN',
      authors: 'Ada Lovelace',
      year: 2024,
      doi: '10.1234/foo',
      url: null,
      venue: 'SIGCOMM',
      item_type: 'article',
    };
    expect(renderBibtex([item])).toContain('@article{ada2024,');
    expect(renderHayagriva([item])).toContain('ada2024:');
  });
});

describe('fsCiteFiles.exportAll (C-08)', () => {
  const item = {
    bibtex_key: 'ada2024',
    title: 'GNN',
    authors: 'Ada Lovelace',
    year: 2024,
    doi: '10.1234/foo',
    url: null,
    venue: 'SIGCOMM',
    item_type: 'article',
  };

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'biblio-cite-'));
    mkdirSync(join(dir, 'mypaper'), { recursive: true });
    const bibPath = join(dir, 'mypaper', 'refs.bib');
    writeFileSync(bibPath, '');
    const db = openDb({ path: ':memory:' });
    const project = createProject(db, { title: 't', summary: 's', embed_model: 'm' });
    setProjectRoot(db, project.project_id, dir);
    return { dir, bibPath, db, projectId: project.project_id };
  }

  it('初回は新規にマーカーを作る', () => {
    const { dir, bibPath, db, projectId } = setup();
    try {
      const cites = fsCiteFiles(db);
      expect(cites.exportAll(projectId, [item])).toBe('ok');
      expect(readFileSync(bibPath, 'utf8')).toContain('@article{ada2024,');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('マーカーごと消された後は復元しない（ADR-0003 却下事項）', () => {
    const { dir, bibPath, db, projectId } = setup();
    try {
      const cites = fsCiteFiles(db);
      expect(cites.exportAll(projectId, [item])).toBe('ok');
      // 利用者がマーカーを含めて丸ごと消した
      writeFileSync(bibPath, '% 自分のメモだけ残す\n');
      expect(cites.exportAll(projectId, [item])).toBe('skipped');
      expect(readFileSync(bibPath, 'utf8')).toBe('% 自分のメモだけ残す\n');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('マーカー内の手編集は上書きしない（ADR-0003 C-08）', () => {
    const { dir, bibPath, db, projectId } = setup();
    try {
      const cites = fsCiteFiles(db);
      expect(cites.exportAll(projectId, [item])).toBe('ok');
      const generated = readFileSync(bibPath, 'utf8');
      // マーカー内に手で行を足す
      writeFileSync(bibPath, generated.replace('@article{ada2024,', '% 手編集\n@article{ada2024,'));
      const edited = readFileSync(bibPath, 'utf8');
      expect(cites.exportAll(projectId, [{ ...item, year: 2025 }])).toBe('conflict');
      expect(readFileSync(bibPath, 'utf8')).toBe(edited);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('手編集が無ければ内容の更新で再生成できる', () => {
    const { dir, bibPath, db, projectId } = setup();
    try {
      const cites = fsCiteFiles(db);
      expect(cites.exportAll(projectId, [item])).toBe('ok');
      expect(cites.exportAll(projectId, [{ ...item, year: 2025 }])).toBe('ok');
      expect(readFileSync(bibPath, 'utf8')).toContain('year = {2025}');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('bffBibliographyGateway', () => {
  const hint = { doi: '10.1234/foo', title: 'GNN' };

  it('200 で record と pdf_url を返す', async () => {
    const got = await bffBibliographyGateway(() =>
      client(new Response(JSON.stringify({ classification: 'C1', record, pdf_url: 'https://arxiv.org/pdf/x.pdf' }), { status: 200 })),
    ).complete(hint);
    expect(got?.record).toEqual(record);
    expect(got?.pdf_url).toBe('https://arxiv.org/pdf/x.pdf');
  });

  it('著者無しでも OA の pdf_url は残す（1 ページ目を後で読ませる）', async () => {
    const got = await bffBibliographyGateway(() =>
      client(
        new Response(
          JSON.stringify({
            classification: 'C1',
            record: {
              title: 'GNN',
              authors: null,
              year: 2024,
              doi: '10.1234/foo',
              url: null,
              venue: null,
              abstract: null,
              item_type: 'article',
            },
            pdf_url: 'https://arxiv.org/pdf/x.pdf',
          }),
          { status: 200 },
        ),
      ),
    ).complete(hint);
    expect(got?.record).toBeNull();
    expect(got?.pdf_url).toBe('https://arxiv.org/pdf/x.pdf');
  });

  it('空レコードは成功にしない', async () => {
    await expect(
      bffBibliographyGateway(() =>
        client(
          new Response(
            JSON.stringify({
              classification: 'C1',
              record: {
                title: null,
                authors: null,
                year: null,
                doi: null,
                url: null,
                venue: null,
                abstract: null,
                item_type: 'article',
              },
            }),
            { status: 200 },
          ),
        ),
      ).complete(hint),
    ).rejects.toThrow(/書誌を補れなかった/);
  });

  it('著者無しは公開文献の補完成功にしない', async () => {
    await expect(
      bffBibliographyGateway(() =>
        client(
          new Response(
            JSON.stringify({
              classification: 'C1',
              record: {
                title: 'GNN',
                authors: null,
                year: 2024,
                doi: '10.1234/foo',
                url: null,
                venue: null,
                abstract: null,
                item_type: 'article',
              },
            }),
            { status: 200 },
          ),
        ),
      ).complete(hint),
    ).rejects.toThrow(/書誌を補れなかった/);
    expect(
      isEmptyRecord({
        title: 'GNN',
        authors: null,
        year: 2024,
        doi: '10.1234/foo',
        url: null,
        venue: null,
        abstract: null,
        item_type: 'article',
      }),
    ).toBe(true);
  });

  it('未ログインは握りつぶさない', async () => {
    await expect(bffBibliographyGateway(() => client(new NotSignedInError())).complete(hint)).rejects.toThrow(
      /クラウドに接続していない/,
    );
  });

  it('502 の detail を出す。空成功にしない', async () => {
    await expect(
      bffBibliographyGateway(() =>
        client(new Response(JSON.stringify({ error: 'upstream_failed', detail: 'openalex status=503' }), { status: 502 })),
      ).complete(hint),
    ).rejects.toThrow(/openalex status=503/);
  });

  it('クライアントが無ければ null（未ログインでフォルダ追従を止めない）', async () => {
    await expect(bffBibliographyGateway(() => null).complete(hint)).resolves.toBeNull();
  });
});

describe('followReference', () => {
  it('書誌をマージし、添付が無ければ OA PDF を取る', async () => {
    const repo = memoryRepo([snapshot()]);
    const downloads: string[] = [];
    const cites: string[][] = [];
    const got = await followReference(
      deps({
        refs: repo,
        pdfs: {
          download: async (url) => {
            downloads.push(url);
            return 'ok';
          },
          rememberWrite() {},
          wasWritten: () => false,
        },
        cites: {
          exportAll(_id, items) {
            cites.push(items.map((i) => i.bibtex_key));
            return 'ok';
          },
        },
      }),
      'p1',
      'r1',
    );
    expect(got.pdf).toBe('ok');
    expect(repo.get('r1')?.authors).toBe('Ada');
    expect(downloads).toEqual(['https://arxiv.org/pdf/x.pdf']);
    expect(cites[0]).toContain('gnn2024');
    expect(repo.attachments('r1')[0]?.path).toBe('/proj/references/gnn2024.pdf');
  });

  it('既に PDF があればダウンロードしない', async () => {
    const repo = memoryRepo([snapshot()]);
    repo.addAttachment('r1', '/already.pdf');
    const download = vi.fn(async () => 'ok' as const);
    const got = await followReference(deps({ refs: repo, pdfs: { download, rememberWrite() {}, wasWritten: () => false } }), 'p1', 'r1');
    expect(got.pdf).toBe('skipped');
    expect(download).not.toHaveBeenCalled();
  });

  it('書誌失敗でも文献行は残す', async () => {
    const repo = memoryRepo([snapshot({ authors: null })]);
    const got = await followReference(
      deps({
        refs: repo,
        gateway: {
          complete: async () => {
            throw new Error('書誌を補れなかった');
          },
        },
      }),
      'p1',
      'r1',
    );
    expect(got.pdf).toBe('skipped');
    expect(repo.get('r1')?.title).toBe('GNN');
  });

  it('候補 PDF の 1 ページ目を先に渡す', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'biblio-cand-'));
    try {
      const repo = memoryRepo([snapshot({ authors: null })]);
      repo.paperId = () => 'paper-1';
      repo.projectRoot = () => dir;
      const complete = vi.fn(async (hint: { first_page?: string }) => {
        expect(hint.first_page).toContain('Ada Lovelace');
        return { record: { ...record, authors: 'Ada Lovelace; Alan Turing' }, pdf_url: null };
      });
      const extract = {
        fromBytes: async () => ({
          title: null,
          authors: null,
          year: null,
          doi: null,
          firstPageText: null,
          titleSource: null,
        }),
        firstPageFromPath: async (path: string) =>
          path.includes('paper-1') ? 'Ada Lovelace; Alan Turing\nHigh-speed I/O' : null,
      };
      const src = candidatePdfPath(dir, 'paper-1');
      mkdirSync(join(dir, 'candidates'), { recursive: true });
      mkdirSync(join(dir, 'references'), { recursive: true });
      writeFileSync(src, '%PDF-1.4\n');

      const got = await followReference(
        deps({
          refs: repo,
          gateway: { complete },
          extract,
          paths: {
            resolve: (p) => p,
            basename: (p) => p.split('/').pop() ?? p,
            isPdf: (p) => p.toLowerCase().endsWith('.pdf'),
            oaDest: (root, key) => join(root, 'references', `${key}.pdf`),
          },
        }),
        'p1',
        'r1',
      );
      expect(got.pdf).toBe('exists');
      expect(repo.get('r1')?.authors).toBe('Ada Lovelace; Alan Turing');
      expect(complete).toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('PDF を取ったあと 1 ページ目で著者を取り直す', async () => {
    const repo = memoryRepo([snapshot({ authors: null })]);
    const complete = vi.fn(async (hint: { first_page?: string }) => {
      if (!hint.first_page) {
        return { record: null, pdf_url: 'https://arxiv.org/pdf/x.pdf' };
      }
      expect(hint.first_page).toContain('title page');
      return { record: { ...record, authors: 'From PDF' }, pdf_url: 'https://arxiv.org/pdf/x.pdf' };
    });
    const download = vi.fn(async () => 'ok' as const);
    const got = await followReference(
      deps({
        refs: repo,
        gateway: { complete },
        pdfs: { download, rememberWrite() {}, wasWritten: () => false },
        extract: {
          fromBytes: async () => ({
            title: null,
            authors: null,
            year: null,
            doi: null,
            firstPageText: null,
            titleSource: null,
          }),
          firstPageFromPath: async (path: string) => (path.includes('references') ? 'title page authors' : null),
        },
      }),
      'p1',
      'r1',
    );
    expect(got.pdf).toBe('ok');
    expect(download).toHaveBeenCalled();
    expect(complete.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(repo.get('r1')?.authors).toBe('From PDF');
  });
});

describe('ingestPdf', () => {
  it('同じパスなら既存に追従する', async () => {
    const repo = memoryRepo([snapshot()]);
    repo.addAttachment('r1', '/a.pdf');
    const add = vi.fn(repo.add);
    repo.add = add;
    const got = await ingestPdf(deps({ refs: repo }), 'p1', '/a.pdf', new Uint8Array());
    expect(got.existing).toBe(true);
    expect(got.reference_id).toBe('r1');
    expect(add).not.toHaveBeenCalled();
  });

  it('同じ DOI なら添付だけ足す', async () => {
    const repo = memoryRepo([snapshot({ doi: '10.1234/foo' })]);
    const got = await ingestPdf(deps({ refs: repo }), 'p1', '/new.pdf', new Uint8Array());
    expect(got.existing).toBe(true);
    expect(got.reference_id).toBe('r1');
    expect(repo.attachments('r1').map((a) => a.path)).toContain('/new.pdf');
  });

  it('新規なら文献を作り、タイトル推測を返す', async () => {
    const repo = memoryRepo([]);
    const got = await ingestPdf(
      deps({
        refs: repo,
        gateway: { complete: async () => null },
        extract: {
          fromBytes: async () => ({
            title: null,
            authors: null,
            year: null,
            doi: null,
            firstPageText: null,
            titleSource: null,
          }),
          firstPageFromPath: async () => null,
        },
      }),
      'p1',
      '/papers/mystery.pdf',
      new Uint8Array(),
    );
    expect(got.existing).toBe(false);
    expect(got.guessed).toBe(true);
    expect(repo.get(got.reference_id)?.title).toBe('mystery');
  });
});
