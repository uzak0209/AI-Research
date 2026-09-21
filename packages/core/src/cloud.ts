import type { AuthSession } from './session';

export class NotSignedInError extends Error {
  constructor() {
    super('not signed in');
    this.name = 'NotSignedInError';
  }
}

type TokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
};

/**
 * access を Authorization に載せる。401 なら refresh して一度だけやり直す。
 * レンダラから呼ばない。メイン / CLI だけ。
 */
export class CloudClient {
  constructor(
    private readonly endpoint: string,
    private readonly session: AuthSession,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async refreshAccess(): Promise<string> {
    const refresh = this.session.getRefreshToken();
    if (!refresh) throw new NotSignedInError();
    const res = await this.fetchImpl(new URL('/auth/refresh', this.endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: refresh }),
    });
    if (!res.ok) {
      if (res.status === 401) this.session.clear();
      throw new Error(`refresh failed: ${res.status}`);
    }
    const body = (await res.json()) as TokenResponse;
    this.session.setAccessToken(body.access_token);
    return body.access_token;
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    let access = this.session.getAccessToken() ?? (await this.refreshAccess());
    const send = (token: string) => {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${token}`);
      return this.fetchImpl(new URL(path, this.endpoint), { ...init, headers });
    };
    let res = await send(access);
    if (res.status === 401) {
      access = await this.refreshAccess();
      res = await send(access);
    }
    return res;
  }

  /** C1 トレンド。本文に手元論文や原稿を載せない（C-09） */
  trends(topic: string): Promise<Response> {
    return this.fetch('/bff/trends', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic }),
    });
  }

  async loginGoogle(input: {
    code: string;
    code_verifier: string;
    redirect_uri: string;
  }): Promise<void> {
    const res = await this.fetchImpl(new URL('/auth/google', this.endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      let detail = `status=${res.status}`;
      try {
        const body = (await res.json()) as { detail?: string };
        if (typeof body.detail === 'string' && body.detail) detail = body.detail;
      } catch {
        // status で足りる
      }
      if (res.status === 501) throw new Error('Google ログインがクラウド側で閉じている');
      throw new Error(`google login failed: ${detail}`);
    }
    const body = (await res.json()) as TokenResponse & { refresh_token?: string };
    if (!body.refresh_token || !body.access_token) {
      throw new Error('google login failed: missing tokens');
    }
    this.session.setRefreshToken(body.refresh_token);
    this.session.setAccessToken(body.access_token);
  }

  async googleClientId(): Promise<string> {
    const url = new URL('/auth/google', this.endpoint.endsWith('/') ? this.endpoint : `${this.endpoint}/`);
    // Hono は末尾スラッシュ付きを 404 にする。必ずスラッシュ無しに正規化する
    url.pathname = '/auth/google';
    const res = await this.fetchImpl(url);
    if (res.status === 501) throw new Error('Google ログインがクラウド側で閉じている');
    if (!res.ok) throw new Error(`google client_id failed: ${res.status} (${url.href})`);
    const body = (await res.json()) as { client_id?: string };
    if (!body.client_id) throw new Error('google client_id failed: empty');
    return body.client_id;
  }

  /**
   * C1 公開書誌の補完。Orca 安価モデルの構造化出力（ADR-0002）。
   * 原稿・ノートは載せない。hint は公開文献の穴と 1 ページ目テキスト。
   */
  bibliography(hint: BibliographyHint): Promise<Response> {
    return this.fetch('/bff/bibliography', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(hint),
    });
  }

  /** 収集 run の増分取得（GET /runs）。LLM を通らない（ADR-0004） */
  async pullRuns(projectId: string, after?: string | null): Promise<SyncRunsResponse> {
    const q = new URLSearchParams({ project_id: projectId });
    if (after) q.set('after', after);
    const res = await this.fetch(`/runs?${q}`);
    if (!res.ok) throw new Error(`pullRuns failed: ${res.status}`);
    return (await res.json()) as SyncRunsResponse;
  }

  /** 課題意識（title / summary）をクラウドへ。判定の書き戻しではない（C-01） */
  async putProject(
    projectId: string,
    input: { title: string; summary: string },
  ): Promise<{ project_id: string; title: string; summary: string }> {
    const res = await this.fetch(`/projects/${encodeURIComponent(projectId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`putProject failed: ${res.status}`);
    return (await res.json()) as { project_id: string; title: string; summary: string };
  }

  /** 自発調査。Queue 投入のみ（FR-17）。収集本体は worker consumer */
  async startCollect(projectId: string): Promise<CollectAccepted> {
    const res = await this.fetch(`/projects/${encodeURIComponent(projectId)}/collect`, {
      method: 'POST',
    });
    if (res.status === 429) {
      const body = (await res.json().catch(() => null)) as { detail?: string } | null;
      throw new Error(body?.detail?.trim() || '短時間に何度も調査を開始できない（約 60 秒待ってください）');
    }
    if (!res.ok) throw new Error(`startCollect failed: ${res.status}`);
    return (await res.json()) as CollectAccepted;
  }
}

/** Worker `BibliographyBodySchema` と同じ。title か doi の少なくとも一方 */
export type BibliographyHint = {
  title?: string;
  authors?: string;
  year?: number;
  doi?: string;
  url?: string;
  venue?: string;
  abstract?: string;
  first_page?: string;
};

/** Worker `BibliographyRecordSchema` と同じ。不採用は項目が null（C-07） */
export type BibliographyRecord = {
  title: string | null;
  authors: string | null;
  year: number | null;
  doi: string | null;
  url: string | null;
  venue: string | null;
  abstract: string | null;
  item_type: string;
};

export type SyncPaper = {
  external_id: string;
  source: string;
  title: string;
  authors: string | null;
  abstract: string | null;
  url: string | null;
  published_at: string | null;
  coarse_score: number | null;
  problem_excerpt: string | null;
};

export type SyncRun = {
  run_id: string;
  run_date: string;
  status: string;
  failed_sources_json: string | null;
  created_at: string;
  papers: SyncPaper[];
};

export type SyncRunsResponse = { project_id: string; runs: SyncRun[] };

export type CollectAccepted = {
  project_id: string;
  run_id: string;
  run_date: string;
  enqueued: number;
};
