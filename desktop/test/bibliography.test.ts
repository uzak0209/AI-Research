import { describe, expect, it, vi } from 'vitest';
import { NotSignedInError, type CloudClient } from '@ai-research/core';
import { followReference } from '../src/bibliography/application/follow-reference.js';
import { ingestPdf } from '../src/bibliography/application/ingest-pdf.js';
import type { BibliographyDeps, ReferenceRepo } from '../src/bibliography/application/ports.js';
import { doiFromExternalId } from '../src/bibliography/domain/doi.js';
import {
  BIB_BEGIN,
  BIB_END,
  renderBibtex,
  renderHayagriva,
  spliceManaged,
} from '../src/bibliography/domain/cite-format.js';
import { httpsPdfUrl } from '../src/bibliography/domain/oa-url.js';
import { hintFromReference, isEmptyRecord, mergeRecord, type ReferenceSnapshot } from '../src/bibliography/domain/record.js';
import { bffBibliographyGateway } from '../src/bibliography/infrastructure/adapters.js';

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
    cites: { exportAll() {} },
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

describe('cite markers', () => {
  it('マーカーが無ければ末尾に足す。片方だけなら触らない（C-08）', () => {
    expect(spliceManaged('hello', '@article{a,}', BIB_BEGIN, BIB_END)).toContain(BIB_BEGIN);
    expect(spliceManaged(`${BIB_BEGIN}\nold\n${BIB_END}\n`, '@article{a,}', BIB_BEGIN, BIB_END)).toContain(
      '@article{a,}',
    );
    expect(spliceManaged(BIB_BEGIN, 'x', BIB_BEGIN, BIB_END)).toBeNull();
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

describe('bffBibliographyGateway', () => {
  const hint = { doi: '10.1234/foo', title: 'GNN' };

  it('200 で record と pdf_url を返す', async () => {
    const got = await bffBibliographyGateway(() =>
      client(new Response(JSON.stringify({ classification: 'C1', record, pdf_url: 'https://arxiv.org/pdf/x.pdf' }), { status: 200 })),
    ).complete(hint);
    expect(got?.record).toEqual(record);
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
