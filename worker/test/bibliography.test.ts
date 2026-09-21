import { describe, expect, it } from 'vitest';
import {
  NONE_KEY,
  adoptCandidate,
  bibliographyQuestions,
  candidateToRecord,
  itemTypeFromOpenAlex,
  normalizeDoi,
  openAlexBibliographyUrl,
  workToCandidate,
} from '../src/bibliography';

describe('normalizeDoi', () => {
  it('https://doi.org/ を落とす', () => {
    expect(normalizeDoi('https://doi.org/10.1234/foo')).toBe('10.1234/foo');
  });
});

describe('itemTypeFromOpenAlex', () => {
  it('proceedings は inproceedings', () => {
    expect(itemTypeFromOpenAlex('proceedings-article')).toBe('inproceedings');
  });
  it('未知は misc（捏造しない）', () => {
    expect(itemTypeFromOpenAlex('preprint')).toBe('misc');
  });
});

describe('workToCandidate', () => {
  it('著者は display_name を ; でつなぐ。DOI は 10. から', () => {
    const c = workToCandidate(
      {
        id: 'https://openalex.org/W1',
        doi: 'https://doi.org/10.1234/foo',
        display_name: 'A study of DPDK',
        publication_year: 2024,
        type: 'article',
        authorships: [
          { author: { display_name: 'Ada Lovelace' } },
          { author: { display_name: 'Alan Turing' } },
        ],
        primary_location: {
          landing_page_url: 'https://example.org/paper',
          source: { display_name: 'SIGCOMM' },
        },
      },
      0,
    );
    expect(c).toMatchObject({
      key: 'w0',
      title: 'A study of DPDK',
      authors: 'Ada Lovelace; Alan Turing',
      year: 2024,
      doi: '10.1234/foo',
      venue: 'SIGCOMM',
      item_type: 'article',
    });
  });
});

describe('adoptCandidate', () => {
  const candidates = [
    {
      key: 'w0',
      title: 'A',
      authors: 'Ada',
      year: 2024,
      doi: '10.1234/a',
      url: 'https://doi.org/10.1234/a',
      venue: 'X',
      abstract: null,
      item_type: 'article',
    },
  ];

  it('choice が none なら採用しない', () => {
    expect(
      adoptCandidate(
        {
          match: { type: 'choice', choice: NONE_KEY, confidence: 0.99 },
          same_work: { type: 'noul', noul: 0.99 },
        },
        candidates,
      ),
    ).toBeNull();
  });

  it('confidence が閾値未満なら採用しない', () => {
    expect(
      adoptCandidate(
        {
          match: { type: 'choice', choice: 'w0', confidence: 0.2 },
          same_work: { type: 'noul', noul: 0.99 },
        },
        candidates,
      ),
    ).toBeNull();
  });

  it('noul と choice が揃えば OpenAlex の行を返す', () => {
    const got = adoptCandidate(
      {
        match: { type: 'choice', choice: 'w0', confidence: 0.9 },
        same_work: { type: 'noul', noul: 0.85 },
      },
      candidates,
    );
    expect(got?.doi).toBe('10.1234/a');
    expect(candidateToRecord(got!).authors).toBe('Ada');
  });
});

describe('openAlexBibliographyUrl', () => {
  it('DOI があれば filter で引き、生成用の search に落とさない', () => {
    const url = openAlexBibliographyUrl({ doi: 'https://doi.org/10.1234/foo' }, { apiKey: 'k' });
    expect(url.searchParams.get('filter')).toBe('doi:10.1234/foo');
    expect(url.searchParams.get('search')).toBeNull();
    expect(url.searchParams.get('api_key')).toBe('k');
    expect(url.searchParams.get('filter')).not.toContain('has_abstract');
  });

  it('題だけなら search', () => {
    const url = openAlexBibliographyUrl({ title: 'DPDK at 100Gbps' });
    expect(url.searchParams.get('search')).toBe('DPDK at 100Gbps');
    expect(url.searchParams.get('filter')).toBeNull();
  });
});

describe('bibliographyQuestions', () => {
  it('none と候補キーを choice に載せる', () => {
    const q = bibliographyQuestions([
      {
        key: 'w0',
        title: 'A',
        authors: null,
        year: 2024,
        doi: '10.1/a',
        url: null,
        venue: null,
        abstract: null,
        item_type: 'article',
      },
    ]);
    expect(q.match.type).toBe('choice');
    if (q.match.type === 'choice') {
      expect(q.match.criteria.none).toBeTruthy();
      expect(q.match.criteria.w0).toContain('A');
    }
  });
});
