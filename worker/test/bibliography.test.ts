import { describe, expect, it } from 'vitest';
import { completeBibliography } from '../src/bibliography/application/complete';
import type { BibliographyDeps } from '../src/bibliography/application/ports';
import { bibliographyPrompt, recordFromModelText } from '../src/bibliography/domain/record';
import { httpsPdfUrl, oaBiblioFromWork, oaPdfUrlFromWork } from '../src/bibliography/domain/oa-url';
import { openAlexPdfUrl } from '../src/bibliography/infrastructure/adapters';
import { authorsFromAuthorships } from '../src/shared/papers/domain';

function deps(over: Partial<BibliographyDeps> = {}): BibliographyDeps {
  return {
    llm: { complete: async () => ({ ok: false }) },
    oaPdf: { lookup: async () => null },
    ...over,
  };
}

describe('httpsPdfUrl', () => {
  it('https の直リンクだけ通す', () => {
    expect(httpsPdfUrl('https://arxiv.org/pdf/1234.pdf')).toBe('https://arxiv.org/pdf/1234.pdf');
    expect(httpsPdfUrl('http://arxiv.org/pdf/1234.pdf')).toBeNull();
    expect(httpsPdfUrl('https://publisher.example/abs.html')).toBeNull();
    expect(httpsPdfUrl(null)).toBeNull();
  });
});

describe('oaPdfUrlFromWork', () => {
  it('best_oa_location.pdf_url を優先する', () => {
    expect(
      oaPdfUrlFromWork({
        best_oa_location: { pdf_url: 'https://arxiv.org/pdf/a.pdf' },
        primary_location: { pdf_url: 'https://other.example/x.pdf' },
      }),
    ).toBe('https://arxiv.org/pdf/a.pdf');
  });

  it('無い・HTML は null（未取得。成功と偽らない）', () => {
    expect(oaPdfUrlFromWork({ best_oa_location: { pdf_url: 'https://ex.example/paper.html' } })).toBeNull();
    expect(oaPdfUrlFromWork({})).toBeNull();
  });
});

describe('openAlexPdfUrl', () => {
  it('DOI で 1 件引き、書誌検索用の search に落とさない', () => {
    const url = openAlexPdfUrl('https://doi.org/10.1234/foo', { apiKey: 'k' });
    expect(url.searchParams.get('filter')).toBe('doi:10.1234/foo');
    expect(url.searchParams.get('search')).toBeNull();
    expect(url.searchParams.get('api_key')).toBe('k');
  });
});

describe('recordFromModelText', () => {
  it('JSON をパースし、DOI が形を成さなければ落とす', () => {
    const got = recordFromModelText(
      JSON.stringify({
        title: 'A study of DPDK',
        authors: 'Ada Lovelace',
        year: 2024,
        doi: '10.1234/foo',
        url: 'https://doi.org/10.1234/foo',
        venue: 'SIGCOMM',
        abstract: null,
        item_type: 'article',
      }),
    );
    expect(got).toMatchObject({ title: 'A study of DPDK', doi: '10.1234/foo', item_type: 'article' });
  });

  it('捏造 DOI や壊れた JSON は空レコード（C-07）', () => {
    expect(recordFromModelText('not json').title).toBeNull();
    expect(recordFromModelText(JSON.stringify({ title: 'X', doi: 'not-a-doi', item_type: 'article' })).doi).toBeNull();
  });

  it('フェンス付き JSON も読む', () => {
    const got = recordFromModelText('```json\n{"title":"GNN","authors":null,"year":null,"doi":null,"url":null,"venue":null,"abstract":null,"item_type":"article"}\n```');
    expect(got.title).toBe('GNN');
  });

  it('authors が配列でも文字列に直す。欠けたキーは null', () => {
    const got = recordFromModelText(
      JSON.stringify({
        title: 'GNN',
        authors: ['Ada Lovelace', { name: 'Alan Turing' }],
        year: '2024',
        doi: '10.1234/foo',
        item_type: 'article',
      }),
    );
    expect(got.authors).toBe('Ada Lovelace; Alan Turing');
    expect(got.year).toBe(2024);
    expect(got.venue).toBeNull();
  });
});

describe('authorsFromAuthorships', () => {
  it('display_name を優先し raw_author_name で補う', () => {
    expect(
      authorsFromAuthorships([
        { author: { display_name: 'Ada Lovelace' } },
        { raw_author_name: 'Alan Turing' },
      ]),
    ).toBe('Ada Lovelace; Alan Turing');
    expect(authorsFromAuthorships([])).toBeNull();
    expect(authorsFromAuthorships(null)).toBeNull();
  });
});

describe('oaBiblioFromWork', () => {
  it('DOI 一致の work から著者・年・会場を取る', () => {
    const got = oaBiblioFromWork({
      display_name: 'GNN',
      publication_year: 2024,
      authorships: [{ author: { display_name: 'Ada Lovelace' } }],
      primary_location: {
        pdf_url: 'https://arxiv.org/pdf/x.pdf',
        source: { display_name: 'SIGCOMM' },
      },
    });
    expect(got).toMatchObject({
      title: 'GNN',
      authors: 'Ada Lovelace',
      year: 2024,
      venue: 'SIGCOMM',
      pdf_url: 'https://arxiv.org/pdf/x.pdf',
    });
  });
});

describe('completeBibliography', () => {
  const hint = { doi: '10.1234/foo', title: 'GNN' };
  const json = JSON.stringify({
    title: 'GNN',
    authors: 'Ada',
    year: 2024,
    doi: '10.1234/foo',
    url: 'https://doi.org/10.1234/foo',
    venue: 'SIGCOMM',
    abstract: null,
    item_type: 'article',
  });

  it('注入した LLM と OA 照会だけ使う', async () => {
    const got = await completeBibliography(
      deps({
        llm: {
          complete: async () => ({
            ok: true,
            text: json,
            model: 'cheap',
            requestedModel: 'openai/gpt-4o-mini',
            tokens: 12,
            costUsd: null,
            latencyMs: 1,
            fallbackUsed: false,
          }),
        },
        oaPdf: {
          lookup: async (doi) => {
            expect(doi).toBe('10.1234/foo');
            return {
              title: null,
              authors: null,
              year: null,
              venue: null,
              pdf_url: 'https://arxiv.org/pdf/x.pdf',
            };
          },
        },
      }),
      hint,
    );
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.record.title).toBe('GNN');
    expect(got.pdf_url).toBe('https://arxiv.org/pdf/x.pdf');
    expect(got.model).toBe('cheap');
  });

  it('LLM 失敗は 502。OA 失敗は pdf_url を null にして書誌は返す', async () => {
    await expect(completeBibliography(deps(), hint)).resolves.toMatchObject({ ok: false, detail: 'orcarouter' });

    const got = await completeBibliography(
      deps({
        llm: {
          complete: async () => ({
            ok: true,
            text: json,
            model: 'cheap',
            requestedModel: 'openai/gpt-4o-mini',
            tokens: 1,
            costUsd: null,
            latencyMs: 1,
            fallbackUsed: false,
          }),
        },
        oaPdf: {
          lookup: async () => {
            throw new Error('openalex');
          },
        },
      }),
      hint,
    );
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.record.title).toBe('GNN');
    expect(got.pdf_url).toBeNull();
  });
});

describe('bibliographyPrompt', () => {
  it('hint と first_page を載せ、原稿やノートは載せない。著者は埋める', () => {
    const p = bibliographyPrompt({ title: 'DPDK', first_page: 'Abstract: we present' });
    expect(p).toContain('DPDK');
    expect(p).toContain('we present');
    expect(p).toContain('authors is required');
    expect(p).not.toContain('mypaper');
    expect(p).not.toContain('note');
  });
});
