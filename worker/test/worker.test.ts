// ADR-0004 / FR-08 / C-07 が壊れていないかを見る。
// 「動くこと」より「欠損を成功と偽らないこと」を重点的に確かめる。

import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  coarseScore,
  handleFetch,
  handleQueueMessage,
  handleScheduled,
  rebuildAbstract,
  utcDate,
  type CollectMessage,
} from '../src/index';
import { openAlexWorksUrl, collectFromPublicationDate, fetchFromSource } from '../src/shared/openalex/adapter';
import { itemTypeFromOpenAlex, pickOaPdfUrl, publicWorkUrl } from '../src/shared/papers/domain';
import { pickTopPapers } from '../src/collect/application/ingest';

const RUN_DATE = '2026-09-20';
const PROJECT = 'proj-1';

async function seedProject() {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM run_papers'),
    env.DB.prepare('DELETE FROM runs'),
    env.DB.prepare('DELETE FROM projects'),
    env.DB.prepare('INSERT OR IGNORE INTO users (user_id, oauth_subject) VALUES (?, ?)').bind('u1', 'sub-1'),
    env.DB.prepare(
      'INSERT INTO projects (project_id, user_id, title, summary) VALUES (?, ?, ?, ?)',
    ).bind(PROJECT, 'u1', 'test', 'graph neural networks molecular property prediction'),
  ]);
}

const message = (over: Partial<CollectMessage> = {}): CollectMessage => ({
  run_id: `${PROJECT}:${RUN_DATE}`,
  project_id: PROJECT,
  summary: 'graph neural networks molecular property prediction',
  source: 'openalex',
  run_date: RUN_DATE,
  ...over,
});

/**
 * OpenAlex の応答を差し替える。テストで外部 API を叩かない。
 * Response の body は一度しか読めないので、呼ばれるたびに作り直す
 * （使い回すと 2 回目に "Body has already been used" になる）
 */
/** 収集 1 段目の分解。検索語は LLM しか作らないので、ここが空だと収集は失敗する */
const DECOMPOSITION = JSON.stringify({
  core: ['GNN'],
  related: ['GCN', 'GAT', 'MPNN'],
});

function orcaResponse(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function mockOpenAlex(works: unknown[], status = 200, decomposition: string | null = DECOMPOSITION) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input) => {
      const url = String(input);
      // 収集 1 段目が Orca に検索語を取りに行く。テストでは外部を叩かない
      if (url.includes('orcarouter')) {
        return decomposition === null
          ? new Response('no', { status: 502 })
          : orcaResponse(decomposition);
      }
      return new Response(JSON.stringify({ results: works }), { status });
    });
}

beforeEach(async () => {
  await seedProject();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --------------------------------------------------------------- HTTP

describe('HTTP', () => {
  it('/health は 200 を返す', async () => {
    const res = await handleFetch(new Request('https://api.test/health'), env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
  });

  it('同期 API は Bearer 無しなら 401。空配列で「0 件」に見せかけない（C-07）', async () => {
    const res = await handleFetch(new Request('https://api.test/runs?project_id=proj-1'), env);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('unauthorized');
  });

  it('GET /runs は自プロジェクトの run を返す。0 件も 200', async () => {
    const { signAccessToken } = await import('../src/auth');
    const token = await signAccessToken(env.JWT_SIGNING_KEY!, 'sub-1');
    await env.DB.prepare(
      'INSERT INTO runs (run_id, project_id, run_date, status) VALUES (?, ?, ?, ?)',
    )
      .bind(`${PROJECT}:sync`, PROJECT, RUN_DATE, 'empty')
      .run();

    const res = await handleFetch(
      new Request(`https://api.test/runs?project_id=${PROJECT}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { project_id: string; runs: { run_id: string }[] };
    expect(body.project_id).toBe(PROJECT);
    expect(body.runs.some((r) => r.run_id === `${PROJECT}:sync`)).toBe(true);
    const run = (body.runs as { run_id: string; search_terms: string[] }[]).find(
      (r) => r.run_id === `${PROJECT}:sync`,
    );
    expect(run?.search_terms).toEqual([]);
    expect((run as { trend?: string | null; themes?: string[] })?.trend ?? null).toBeNull();
    expect((run as { themes?: string[] })?.themes).toEqual([]);
  });

  it('PUT /projects は summary を upsert する', async () => {
    const { signAccessToken } = await import('../src/auth');
    const token = await signAccessToken(env.JWT_SIGNING_KEY!, 'sub-1');
    const res = await handleFetch(
      new Request('https://api.test/projects/new-proj', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ title: 'T', summary: 'problem-aware graph learning' }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT title, summary FROM projects WHERE project_id = ?')
      .bind('new-proj')
      .first<{ title: string; summary: string }>();
    expect(row?.title).toBe('T');
    expect(row?.summary).toBe('problem-aware graph learning');
  });

  it('PUT /projects は search_terms を残す', async () => {
    const { signAccessToken } = await import('../src/auth');
    const token = await signAccessToken(env.JWT_SIGNING_KEY!, 'sub-1');
    const res = await handleFetch(
      new Request('https://api.test/projects/terms-proj', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          title: 'T',
          summary: 'DPDK latency',
          search_terms: ['DPDK', 'XDP'],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { search_terms: string[] };
    expect(body.search_terms).toEqual(['DPDK', 'XDP']);
    const row = await env.DB.prepare('SELECT search_terms_json FROM projects WHERE project_id = ?')
      .bind('terms-proj')
      .first<{ search_terms_json: string }>();
    expect(JSON.parse(row?.search_terms_json ?? '[]')).toEqual(['DPDK', 'XDP']);
  });

  it('refresh から新しい access を出せる', async () => {
    const { signRefreshToken, verifyToken } = await import('../src/auth');
    const refresh = await signRefreshToken(env.JWT_SIGNING_KEY!, 'sub-1');
    const res = await handleFetch(
      new Request('https://api.test/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: refresh }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; token_type: string };
    expect(body.token_type).toBe('bearer');
    const payload = await verifyToken(env.JWT_SIGNING_KEY!, body.access_token);
    expect(payload.sub).toBe('sub-1');
    expect(payload.typ).toBe('access');
  });

  it('access を refresh に使うと 401', async () => {
    const { signAccessToken } = await import('../src/auth');
    const access = await signAccessToken(env.JWT_SIGNING_KEY!, 'sub-1');
    const res = await handleFetch(
      new Request('https://api.test/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: access }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('BFF の未実装経路は Bearer 無しなら 401（自由プロキシを作らない。ADR-0002）', async () => {
    const res = await handleFetch(new Request('https://api.test/bff/themes'), env);
    expect(res.status).toBe(401);
  });

  it('知らない経路は 404 で落とす', async () => {
    const res = await handleFetch(new Request('https://api.test/nope'), env);
    expect(res.status).toBe(404);
  });
});

// --------------------------------------------------------------- 純粋関数

describe('粗い採点と要旨の復元', () => {
  it('coarseScore は 0〜1 に収まり、一致が多いほど高い', () => {
    const summary = 'graph neural networks molecular property prediction';
    const hit = coarseScore(summary, 'graph neural networks for molecular property prediction');
    const miss = coarseScore(summary, 'machine translation for low resource languages');
    expect(hit).toBeGreaterThan(miss);
    expect(hit).toBeLessThanOrEqual(1);
    expect(miss).toBeGreaterThanOrEqual(0);
  });

  it('coarseScore は語が無いとき 0 を返す（0 除算しない）', () => {
    expect(coarseScore('', 'anything')).toBe(0);
    expect(coarseScore('a an the', 'anything')).toBe(0); // 4 文字未満は捨てる
  });

  it('DPDK と日本語の語も採点する', () => {
    const topic = 'DPDKによるパケット通信の高速化';
    const hit = coarseScore(topic, 'DPDK packet I/O on commodity NICs パケット forwarding');
    const miss = coarseScore(topic, 'transformer attention is all you need');
    expect(hit).toBeGreaterThan(miss);
    expect(hit).toBeGreaterThan(0);
    expect(miss).toBe(0);
  });

  it('rebuildAbstract は転置インデックスから語順を戻す', () => {
    expect(rebuildAbstract({ we: [0], study: [1], molecules: [2] })).toBe('we study molecules');
  });

  it('rebuildAbstract は欠損を空文字にせず null にする（C-07）', () => {
    expect(rebuildAbstract(null)).toBeNull();
    expect(rebuildAbstract(undefined)).toBeNull();
    expect(rebuildAbstract({})).toBeNull();
  });

  it('utcDate は UTC の YYYY-MM-DD（夏時間の影響を受けない）', () => {
    expect(utcDate(new Date('2026-09-20T23:30:00Z'))).toBe('2026-09-20');
    expect(utcDate(new Date('2026-09-20T00:00:00Z'))).toBe('2026-09-20');
  });
});

describe('OpenAlex URL', () => {
  it('search と api_key を使い、古い filter search は使わない', () => {
    const url = openAlexWorksUrl('DPDK', { apiKey: 'secret-key' });
    expect(url.searchParams.get('search')).toBe('DPDK');
    expect(url.searchParams.get('api_key')).toBe('secret-key');
    expect(url.searchParams.get('sort')).toBe('publication_date:desc');
    expect(url.searchParams.get('filter')).toBe(
      `has_abstract:true,type:article,from_publication_date:${collectFromPublicationDate()}`,
    );
    expect(url.href).not.toContain('title_and_abstract.search');
  });

  it('鍵が無いときは api_key を付けない', () => {
    const url = openAlexWorksUrl('DPDK');
    expect(url.searchParams.get('api_key')).toBeNull();
  });

  it('2 ページ目は page=2', () => {
    expect(openAlexWorksUrl('DPDK', { page: 2 }).searchParams.get('page')).toBe('2');
  });

  it('desktop の papers.url と同じ https URL にする', () => {
    expect(publicWorkUrl({ doi: 'https://doi.org/10.1234/foo' })).toBe('https://doi.org/10.1234/foo');
    expect(publicWorkUrl({ id: 'https://openalex.org/W1' })).toBe('https://openalex.org/W1');
    expect(publicWorkUrl({ landing: 'https://example.org/p', doi: '10.1234/foo' })).toBe('https://example.org/p');
  });

  it('直 PDF も select に入れる。後から 1 件ずつ引き直さない', () => {
    const select = openAlexWorksUrl('DPDK').searchParams.get('select') ?? '';
    expect(select).toContain('best_oa_location');
    expect(select).toContain('locations');
  });

  it('書誌（著者・年・掲載誌・種別）も select に入れる', () => {
    const select = openAlexWorksUrl('DPDK').searchParams.get('select') ?? '';
    expect(select).toContain('authorships');
    expect(select).toContain('publication_date');
    expect(select).toContain('primary_location');
    expect(select).toContain('type');
  });
});

describe('itemTypeFromOpenAlex', () => {
  it('引用の種別へ寄せる', () => {
    expect(itemTypeFromOpenAlex('article')).toBe('article');
    expect(itemTypeFromOpenAlex('preprint')).toBe('preprint');
    expect(itemTypeFromOpenAlex('proceedings-article')).toBe('inproceedings');
    expect(itemTypeFromOpenAlex('book-chapter')).toBe('incollection');
  });

  it('知らない値は article と偽らない（C-07）', () => {
    expect(itemTypeFromOpenAlex('paratext')).toBeNull();
    expect(itemTypeFromOpenAlex(null)).toBeNull();
  });
});

describe('pickOaPdfUrl（arXiv 優先）', () => {
  it('出版社より arXiv を先に選ぶ', () => {
    expect(
      pickOaPdfUrl(['https://publisher.example/x.pdf', 'https://arxiv.org/pdf/2409.00001.pdf']),
    ).toBe('https://arxiv.org/pdf/2409.00001.pdf');
  });

  it('arXiv が無ければ先に来た https 直 PDF', () => {
    expect(pickOaPdfUrl([null, 'https://publisher.example/x.pdf', 'https://other.example/y.pdf'])).toBe(
      'https://publisher.example/x.pdf',
    );
  });

  it('HTML と http は取らない。無ければ null（未取得。C-07）', () => {
    expect(pickOaPdfUrl(['https://publisher.example/abs.html', 'http://arxiv.org/pdf/x.pdf'])).toBeNull();
    expect(pickOaPdfUrl([])).toBeNull();
  });

  it('参考文献だけの PDF と DOI ランディングは後ろに回す', () => {
    expect(
      pickOaPdfUrl(['https://www.nature.com/articles/x_reference.pdf', 'https://publisher.example/full.pdf']),
    ).toBe('https://publisher.example/full.pdf');
    expect(pickOaPdfUrl(['https://doi.org/10.1234/foo', 'https://publisher.example/full.pdf'])).toBe(
      'https://publisher.example/full.pdf',
    );
  });

  it('弱い候補しか無ければそれを返す。勝手に「無し」にしない', () => {
    expect(pickOaPdfUrl(['https://doi.org/10.1234/foo'])).toBe('https://doi.org/10.1234/foo');
  });
});

describe('pickTopPapers（同点なら読めるもの）', () => {
  const base = { title: 't', authors: null, abstract: null, url: null, problem_excerpt: null };

  it('粗点が同じなら OA 直 PDF がある方を上に出す', () => {
    const got = pickTopPapers(
      [
        { ...base, external_id: 'no-pdf', published_at: '2026-09-01', pdf_url: null, coarse_score: 0.5 },
        { ...base, external_id: 'pdf', published_at: '2026-09-01', pdf_url: 'https://arxiv.org/pdf/a.pdf', coarse_score: 0.5 },
      ],
      2,
    );
    expect(got.map((p) => p.external_id)).toEqual(['pdf', 'no-pdf']);
  });

  it('粗点の差は PDF の有無で覆さない', () => {
    const got = pickTopPapers(
      [
        { ...base, external_id: 'pdf', published_at: '2026-09-01', pdf_url: 'https://arxiv.org/pdf/a.pdf', coarse_score: 0.1 },
        { ...base, external_id: 'relevant', published_at: '2026-09-01', pdf_url: null, coarse_score: 0.9 },
      ],
      2,
    );
    expect(got[0]?.external_id).toBe('relevant');
  });
});

describe('fetchFromSource（最新順・既知は飛ばす）', () => {
  function work(id: string, title: string) {
    return {
      id: `https://openalex.org/${id}`,
      doi: `https://doi.org/10.1234/${id}`,
      display_name: title,
      publication_date: '2026-09-01',
      abstract_inverted_index: { dpdk: [0] },
    };
  }

  it('ページが短いときは次を取りに行かない', async () => {
    const spy = mockOpenAlex([work('W1', 'Only one')]);
    const papers = await fetchFromSource('openalex', 'DPDK');
    expect(papers.map((p) => p.external_id)).toEqual(['10.1234/W1']);
    expect(spy.mock.calls.filter(([u]) => String(u).includes('api.openalex.org'))).toHaveLength(1);
  });

  it('先頭にある既知 ID は飛ばし、同じ新しい順の続きを取る', async () => {
    const page1 = Array.from({ length: 25 }, (_, i) => work(`A${i}`, `Old ${i}`));
    const page2 = [work('NEW', 'Brand new DPDK datapath')];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.hostname.includes('orcarouter')) return new Response('no', { status: 502 });
      const page = Number(url.searchParams.get('page') || '1');
      const results = page === 1 ? page1 : page === 2 ? page2 : [];
      return new Response(JSON.stringify({ results }));
    });

    const skipIds = new Set(page1.map((w) => `10.1234/${w.id.replace('https://openalex.org/', '')}`));
    const papers = await fetchFromSource('openalex', 'DPDK', { skipIds, take: 1 });
    expect(papers).toHaveLength(1);
    expect(papers[0]?.title).toBe('Brand new DPDK datapath');
  });
});

// --------------------------------------------------------------- cron

describe('cron（Queues への投入だけ）', () => {
  it('プロジェクト × ソースの数だけ投入する', async () => {
    const sent: unknown[] = [];
    const fakeEnv = {
      ...env,
      COLLECT_QUEUE: { sendBatch: async (b: unknown[]) => void sent.push(...b) },
      IDEMPOTENCY: { get: async () => null, put: async () => {} },
    } as unknown as typeof env;

    await handleScheduled(fakeEnv);
    expect(sent).toHaveLength(1); // プロジェクト 1 × ソース 1
  });

  it('同じ日に二度目は投入しない（cron は at-least-once）', async () => {
    const sent: unknown[] = [];
    const fakeEnv = {
      ...env,
      COLLECT_QUEUE: { sendBatch: async (b: unknown[]) => void sent.push(...b) },
      IDEMPOTENCY: { get: async () => '1', put: async () => {} },
    } as unknown as typeof env;

    await handleScheduled(fakeEnv);
    expect(sent).toHaveLength(0);
  });
});

describe('自発調査 POST /projects/{id}/collect（FR-17）', () => {
  it('Bearer 無しなら 401', async () => {
    const res = await handleFetch(
      new Request(`https://api.test/projects/${PROJECT}/collect`, { method: 'POST' }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('投入して 202 と run_id を返す', async () => {
    const { signAccessToken } = await import('../src/auth');
    const token = await signAccessToken(env.JWT_SIGNING_KEY!, 'sub-1');
    const sent: unknown[] = [];
    const store = new Map<string, string>();
    const fakeEnv = {
      ...env,
      COLLECT_QUEUE: { sendBatch: async (b: unknown[]) => void sent.push(...b) },
      IDEMPOTENCY: {
        get: async (k: string) => store.get(k) ?? null,
        put: async (k: string, v: string) => void store.set(k, v),
      },
    } as unknown as typeof env;

    const res = await handleFetch(
      new Request(`https://api.test/projects/${PROJECT}/collect`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }),
      fakeEnv,
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      project_id: string;
      run_id: string;
      enqueued: number;
    };
    expect(body.project_id).toBe(PROJECT);
    expect(body.run_id).toMatch(new RegExp(`^${PROJECT}:manual:\\d+$`));
    expect(body.enqueued).toBe(sent.length);
    expect(sent.length).toBeGreaterThanOrEqual(1);
  });

  it('連打は 429', async () => {
    const { signAccessToken } = await import('../src/auth');
    const token = await signAccessToken(env.JWT_SIGNING_KEY!, 'sub-1');
    const store = new Map<string, string>([[`collect:manual:u1`, '1']]);
    const fakeEnv = {
      ...env,
      COLLECT_QUEUE: { sendBatch: async () => {} },
      IDEMPOTENCY: {
        get: async (k: string) => store.get(k) ?? null,
        put: async (k: string, v: string) => void store.set(k, v),
      },
    } as unknown as typeof env;

    const res = await handleFetch(
      new Request(`https://api.test/projects/${PROJECT}/collect`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }),
      fakeEnv,
    );
    expect(res.status).toBe(429);
  });
});

// --------------------------------------------------------------- 収集

describe('収集の記録（FR-08 / C-07）', () => {
  it('取得できたら status=ok で run_papers に入る', async () => {
    mockOpenAlex([
      {
        id: 'https://openalex.org/W1',
        doi: 'https://doi.org/10.1234/a',
        display_name: 'GNN for molecular property prediction',
        publication_date: '2026-09-01',
        authorships: [
          { author: { display_name: 'Ada Lovelace' } },
          { raw_author_name: 'Alan Turing' },
        ],
        abstract_inverted_index: { graph: [0], neural: [1], networks: [2] },
        type: 'article',
        best_oa_location: { pdf_url: 'https://publisher.example/full.pdf' },
        primary_location: { source: { display_name: 'SIGCOMM' } },
        // arXiv は locations の後ろに入ることがある。それでも優先する
        locations: [{ pdf_url: 'https://arxiv.org/pdf/2409.00001.pdf' }],
      },
    ]);

    await handleQueueMessage(message(), env);

    const run = await env.DB.prepare('SELECT status, failed_sources_json FROM runs WHERE run_id = ?')
      .bind(`${PROJECT}:${RUN_DATE}`)
      .first<{ status: string; failed_sources_json: string | null }>();
    expect(run?.status).toBe('ok');
    expect(run?.failed_sources_json).toBeNull();

    const papers = await env.DB.prepare(
      `SELECT COUNT(*) AS n, MIN(external_id) AS external_id, MIN(url) AS url, MIN(authors) AS authors,
              MIN(pdf_url) AS pdf_url, MIN(venue) AS venue, MIN(item_type) AS item_type,
              MIN(published_at) AS published_at
         FROM run_papers WHERE run_id = ?`,
    )
      .bind(`${PROJECT}:${RUN_DATE}`)
      .first<{
        n: number;
        external_id: string;
        url: string;
        authors: string;
        pdf_url: string;
        venue: string;
        item_type: string;
        published_at: string;
      }>();
    expect(papers?.n).toBe(1);
    // desktop の papers.external_id / url と同じ形。DOI 生文字列を URL にしない
    expect(papers?.external_id).toBe('10.1234/a');
    expect(papers?.url).toBe('https://doi.org/10.1234/a');
    expect(papers?.authors).toBe('Ada Lovelace; Alan Turing');
    // 収集時に直 PDF まで取り、arXiv を選ぶ（ADR-0003）
    expect(papers?.pdf_url).toBe('https://arxiv.org/pdf/2409.00001.pdf');
    // 候補の時点で引用が書ける（著者・年・掲載誌・種別）。書誌補完を呼ばない
    expect(papers?.venue).toBe('SIGCOMM');
    expect(papers?.item_type).toBe('article');
    expect(papers?.published_at).toBe('2026-09-01');

    const terms = await env.DB.prepare('SELECT search_terms_json FROM runs WHERE run_id = ?')
      .bind(`${PROJECT}:${RUN_DATE}`)
      .first<{ search_terms_json: string }>();
    // 見せる検索語は LLM の分解（主題語が先）。文章から切り出した機能語は載らない
    const parsed = JSON.parse(terms?.search_terms_json ?? '[]') as string[];
    expect(parsed[0]).toBe('GNN');
    expect(parsed).toContain('GAT');
  });

  it('llm_calls に 1 段目・2 段目それぞれ run_id 付きで 1 呼び出し 1 行残る（ADR-0005 §9・§10）', async () => {
    mockOpenAlex([
      {
        id: 'https://openalex.org/W1',
        doi: 'https://doi.org/10.1234/a',
        display_name: 'GNN for molecular property prediction',
        publication_date: '2026-09-01',
        abstract_inverted_index: { graph: [0], neural: [1], networks: [2] },
      },
    ]);

    await handleQueueMessage(message(), env);

    const runId = `${PROJECT}:${RUN_DATE}`;
    const calls = await env.DB.prepare(
      'SELECT stage, run_id, endpoint, requested_model, classification FROM llm_calls ORDER BY stage',
    ).all<{ stage: string; run_id: string; endpoint: string; requested_model: string; classification: string }>();
    const stages = calls.results.map((c) => c.stage).sort();
    expect(stages).toContain('1段目');
    expect(stages).toContain('2段目');
    for (const c of calls.results) {
      expect(c.run_id).toBe(runId);
      expect(c.classification).toBe('C1');
      expect(c.requested_model).toBeTruthy();
    }
  });

  it('検索語を作れなければ failed。0 件と混ぜない（C-07）', async () => {
    // Orca が全滅。機械的な語の切り出しには落とさない
    mockOpenAlex([{ id: 'https://openalex.org/W1', display_name: 'GNN', publication_date: '2026-09-01' }], 200, null);

    await expect(handleQueueMessage(message(), env)).rejects.toThrow();

    const run = await env.DB.prepare('SELECT status FROM runs WHERE run_id = ?')
      .bind(`${PROJECT}:${RUN_DATE}`)
      .first<{ status: string }>();
    expect(run?.status).toBe('failed');

    const papers = await env.DB.prepare('SELECT COUNT(*) AS n FROM run_papers WHERE run_id = ?')
      .bind(`${PROJECT}:${RUN_DATE}`)
      .first<{ n: number }>();
    expect(papers?.n).toBe(0);
  });

  it('0 件は empty。failed にしない', async () => {
    mockOpenAlex([]);

    await handleQueueMessage(message(), env);

    const run = await env.DB.prepare('SELECT status, failed_sources_json FROM runs WHERE run_id = ?')
      .bind(`${PROJECT}:${RUN_DATE}`)
      .first<{ status: string; failed_sources_json: string | null }>();
    expect(run?.status).toBe('empty');
    expect(run?.failed_sources_json).toBeNull();
  });

  it('取得失敗は failed。0 件と混ぜず、欠けた依存を残す', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 503 }));

    // 失敗は再試行のため投げ直される。記録はその前に済んでいる
    await expect(handleQueueMessage(message(), env)).rejects.toThrow();

    const run = await env.DB.prepare('SELECT status, failed_sources_json FROM runs WHERE run_id = ?')
      .bind(`${PROJECT}:${RUN_DATE}`)
      .first<{ status: string; failed_sources_json: string | null }>();
    expect(run?.status).toBe('failed');
    expect(run?.failed_sources_json).toContain('openalex');
  });

  it('同じ日の再実行で status が変わったら partial になる', async () => {
    mockOpenAlex([]); // 1 回目: empty
    await handleQueueMessage(message(), env);
    vi.restoreAllMocks();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    await expect(handleQueueMessage(message(), env)).rejects.toThrow(); // 2 回目: failed

    const run = await env.DB.prepare('SELECT status FROM runs WHERE run_id = ?')
      .bind(`${PROJECT}:${RUN_DATE}`)
      .first<{ status: string }>();
    expect(run?.status).toBe('partial');
  });

  it('同じ論文を二度取り込んでも重複しない（Queues は at-least-once）', async () => {
    const work = {
      id: 'https://openalex.org/W1',
      doi: 'https://doi.org/10.1/a',
      display_name: 'GNN',
      publication_date: '2026-09-01',
      abstract_inverted_index: { graph: [0] },
    };
    mockOpenAlex([work]);
    await handleQueueMessage(message(), env);
    await handleQueueMessage(message(), env);

    const papers = await env.DB.prepare('SELECT COUNT(*) AS n FROM run_papers WHERE run_id = ?')
      .bind(`${PROJECT}:${RUN_DATE}`)
      .first<{ n: number }>();
    expect(papers?.n).toBe(1);
  });

  it('D1 の 1 実行 50 クエリに収まる（Free 枠。25 件でも文は数本）', async () => {
    const works = Array.from({ length: 25 }, (_, i) => ({
      id: `https://openalex.org/W${i}`,
      doi: `https://doi.org/10.1/${i}`,
      display_name: `paper ${i}`,
      publication_date: '2026-09-01',
      abstract_inverted_index: { graph: [0] },
    }));
    mockOpenAlex(works);

    const spy = vi.spyOn(env.DB, 'batch');
    await handleQueueMessage(message(), env);

    const statements = spy.mock.calls[0]?.[0] ?? [];
    // 利用者に渡すのは上位 5 件。runs 1 文 + run_papers 1 文
    expect(statements.length).toBe(2);
    // Free 枠は 1 実行 50 クエリまで
    expect(statements.length).toBeLessThanOrEqual(50);

    const saved = await env.DB.prepare('SELECT COUNT(*) AS n FROM run_papers WHERE run_id = ?')
      .bind(`${PROJECT}:${RUN_DATE}`)
      .first<{ n: number }>();
    expect(saved?.n).toBe(5);
  });

  it('未知のソースは failed として残る（黙って握りつぶさない）', async () => {
    mockOpenAlex([]);
    await expect(handleQueueMessage(message({ source: 'unknown-src' }), env)).rejects.toThrow();

    const run = await env.DB.prepare('SELECT status, failed_sources_json FROM runs WHERE run_id = ?')
      .bind(`${PROJECT}:${RUN_DATE}`)
      .first<{ status: string; failed_sources_json: string | null }>();
    expect(run?.status).toBe('failed');
    expect(run?.failed_sources_json).toContain('unknown-src');
  });
});
