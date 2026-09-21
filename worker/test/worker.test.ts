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
import { openAlexWorksUrl } from '../src/shared/openalex/adapter';
import { publicWorkUrl } from '../src/shared/papers/domain';

const RUN_DATE = '2026-09-20';
const PROJECT = 'proj-1';

async function seedProject() {
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO users (user_id, oauth_subject) VALUES (?, ?)').bind('u1', 'sub-1'),
    env.DB.prepare(
      'INSERT OR IGNORE INTO projects (project_id, user_id, title, summary) VALUES (?, ?, ?, ?)',
    ).bind(PROJECT, 'u1', 'test', 'graph neural networks molecular property prediction'),
  ]);
}

async function clearRuns() {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM run_papers'),
    env.DB.prepare('DELETE FROM runs'),
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
function mockOpenAlex(works: unknown[], status = 200) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response(JSON.stringify({ results: works }), { status }));
}

beforeEach(async () => {
  await seedProject();
  await clearRuns();
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
    const res = await handleFetch(new Request('https://api.test/runs'), env);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('unauthorized');
  });

  it('同期 API は access が通っても中身は 501', async () => {
    const { signAccessToken } = await import('../src/auth');
    const token = await signAccessToken(env.JWT_SIGNING_KEY!, 'sub-1');
    const res = await handleFetch(
      new Request('https://api.test/runs', { headers: { Authorization: `Bearer ${token}` } }),
      env,
    );
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_implemented');
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
    expect(coarseScore('a an the', 'anything')).toBe(0); // 4 文字以下は捨てる
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
    expect(url.searchParams.get('filter')).toBe('has_abstract:true,type:article');
    expect(url.href).not.toContain('title_and_abstract.search');
  });

  it('鍵が無いときは api_key を付けない', () => {
    const url = openAlexWorksUrl('DPDK');
    expect(url.searchParams.get('api_key')).toBeNull();
  });

  it('desktop の papers.url と同じ https URL にする', () => {
    expect(publicWorkUrl({ doi: 'https://doi.org/10.1234/foo' })).toBe('https://doi.org/10.1234/foo');
    expect(publicWorkUrl({ id: 'https://openalex.org/W1' })).toBe('https://openalex.org/W1');
    expect(publicWorkUrl({ landing: 'https://example.org/p', doi: '10.1234/foo' })).toBe('https://example.org/p');
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

// --------------------------------------------------------------- 収集

describe('収集の記録（FR-08 / C-07）', () => {
  it('取得できたら status=ok で run_papers に入る', async () => {
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

    const run = await env.DB.prepare('SELECT status, failed_sources_json FROM runs WHERE run_id = ?')
      .bind(`${PROJECT}:${RUN_DATE}`)
      .first<{ status: string; failed_sources_json: string | null }>();
    expect(run?.status).toBe('ok');
    expect(run?.failed_sources_json).toBeNull();

    const papers = await env.DB.prepare(
      'SELECT COUNT(*) AS n, MIN(external_id) AS external_id, MIN(url) AS url FROM run_papers WHERE run_id = ?',
    )
      .bind(`${PROJECT}:${RUN_DATE}`)
      .first<{ n: number; external_id: string; url: string }>();
    expect(papers?.n).toBe(1);
    // desktop の papers.external_id / url と同じ形。DOI 生文字列を URL にしない
    expect(papers?.external_id).toBe('10.1234/a');
    expect(papers?.url).toBe('https://doi.org/10.1234/a');
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
    // runs 1 文 + run_papers を 12 件ずつ（100 バインド ÷ 8 列）= 3 文。合計 4 文
    expect(statements.length).toBe(4);
    // Free 枠は 1 実行 50 クエリまで
    expect(statements.length).toBeLessThanOrEqual(50);
  });

  it('未知のソースは failed として残る（黙って握りつぶさない）', async () => {
    await expect(handleQueueMessage(message({ source: 'unknown-src' }), env)).rejects.toThrow();

    const run = await env.DB.prepare('SELECT status, failed_sources_json FROM runs WHERE run_id = ?')
      .bind(`${PROJECT}:${RUN_DATE}`)
      .first<{ status: string; failed_sources_json: string | null }>();
    expect(run?.status).toBe('failed');
    expect(run?.failed_sources_json).toContain('unknown-src');
  });
});
