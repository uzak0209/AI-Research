// ADR-0004 のクラウド側。HTTP と cron を 1 つの Worker に同居させる。
//
// **設計フェーズのデプロイ土台。** 未決の部分は実装したふりをせず 501 を返す（C-07）。
//   - 認証の上流 IdP と署名鍵の入れ替え手順が未決 → /runs は 501
//   - BFF の endpoint は分類決定後に作る（ADR-0002）→ /bff/* は 501
//
// Free プランの制約（ADR-0004）:
//   - CPU 10ms / 1 実行。取得結果の解析と採点は CPU に入る
//   - サブリクエスト 50 / 1 実行
//   - D1 は 1 実行 50 クエリまで。1 件ずつ INSERT せず複数行を 1 文にまとめる

export interface Env {
  DB: D1Database;
  IDEMPOTENCY: KVNamespace;
  COLLECT_QUEUE: Queue<CollectMessage>;
  ENVIRONMENT: string;
  CONSENT_VERSION: string;
}

/** 1 メッセージ = 1（プロジェクト × ソース）。実行を分けて 10ms 枠を稼ぐ */
export interface CollectMessage {
  run_id: string;
  project_id: string;
  summary: string;
  source: string;
  run_date: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/** UTC の YYYY-MM-DD。夏時間の影響を受けない（ADR-0004） */
export const utcDate = (d = new Date()) => d.toISOString().slice(0, 10);

// --- HTTP ------------------------------------------------------------------

export async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // 死活確認。認証前に置く唯一の経路
  if (url.pathname === '/health') {
    return json({ ok: true, environment: env.ENVIRONMENT });
  }

  // FR-02 の同期 API。プル専用で、書き戻し経路を作らない（C-01）
  if (url.pathname === '/runs') {
    // 認証の上流 IdP と署名鍵の入れ替えが未決（ADR-0004 の未決）。
    // 検証できないものを通さない。空配列を返して「0 件」に見せかけない（C-07）
    return json(
      { error: 'not_implemented', detail: 'JWT 検証が未実装のため同期 API は閉じている' },
      501,
    );
  }

  // 機能ごとの endpoint を分類決定後に足す。自由プロキシは作らない（ADR-0002）
  if (url.pathname.startsWith('/bff/')) {
    return json(
      { error: 'not_implemented', detail: 'BFF endpoint は分類（C1/C2/C3）決定後に追加する' },
      501,
    );
  }

  // 知らない経路は落とす。エッジの WAF カスタムルールと二重に防ぐ
  return json({ error: 'not_found' }, 404);
}

// --- cron ------------------------------------------------------------------

/** 収集ソース。アダプタで足す（ADR-0001 の拡張点） */
export const SOURCES = ['openalex'] as const;

/**
 * cron は Queues への投入だけを行う。収集本体はコンシューマ側。
 * ここで収集すると全プロジェクト分が CPU 10ms に収まらない。
 */
export async function handleScheduled(env: Env): Promise<void> {
  const runDate = utcDate();

  // cron は at-least-once。同じ日の二重投入を KV で弾く
  const fired = await env.IDEMPOTENCY.get(`cron:${runDate}`);
  if (fired) return;

  const { results } = await env.DB.prepare(
    'SELECT project_id, summary FROM projects',
  ).all<{ project_id: string; summary: string }>();

  const messages: { body: CollectMessage }[] = [];
  for (const p of results ?? []) {
    // run_id は (project_id, run_date) から決まる。再実行しても同じ行に当たる
    const runId = `${p.project_id}:${runDate}`;
    for (const source of SOURCES) {
      messages.push({
        body: { run_id: runId, project_id: p.project_id, summary: p.summary, source, run_date: runDate },
      });
    }
  }

  // 1 件ずつ send すると実行あたりのサブリクエストを食う
  for (let i = 0; i < messages.length; i += 100) {
    await env.COLLECT_QUEUE.sendBatch(messages.slice(i, i + 100));
  }

  // 投入まで終えてから印を付ける。途中で落ちたら次の cron で拾い直す
  await env.IDEMPOTENCY.put(`cron:${runDate}`, '1', { expirationTtl: 60 * 60 * 24 * 3 });
}

// --- Queue コンシューマ ------------------------------------------------------

/** D1 の 1 文あたりのバインド変数の上限 */
const D1_MAX_BIND_PARAMS = 100;
/** run_papers に 1 行あたり入れる列数 */
const RUN_PAPER_COLUMNS = 8;

interface FetchedPaper {
  external_id: string;
  title: string;
  abstract: string | null;
  url: string | null;
  published_at: string | null;
}

/**
 * ソースアダプタ。公開 API のみを叩く。
 * 粗い採点は文字列一致の水準に留める（重い判定はローカル。ADR-0004）
 */
export async function fetchFromSource(source: string, summary: string): Promise<FetchedPaper[]> {
  if (source !== 'openalex') throw new Error(`未知のソース: ${source}`);

  // 概要をそのまま検索語にする。ここで賢く絞ろうとすると CPU 10ms に収まらない
  const q = summary.split(/\s+/).slice(0, 24).join(' ');
  const params = new URLSearchParams({
    filter: `title_and_abstract.search:${q},has_abstract:true,type:article`,
    'per-page': '25',
    sort: 'publication_date:desc',
  });

  const res = await fetch(`https://api.openalex.org/works?${params}`, {
    headers: { 'user-agent': 'ai-research (+https://github.com/uzak0209/AI-Research)' },
  });
  if (!res.ok) throw new Error(`openalex status=${res.status}`);

  const data = (await res.json()) as { results?: OpenAlexWork[] };
  return (data.results ?? []).map((w) => ({
    external_id: w.doi ?? w.id,
    title: w.display_name ?? '',
    abstract: rebuildAbstract(w.abstract_inverted_index),
    url: w.doi ?? w.id ?? null,
    published_at: w.publication_date ?? null,
  }));
}

interface OpenAlexWork {
  id: string;
  doi?: string | null;
  display_name?: string;
  publication_date?: string;
  abstract_inverted_index?: Record<string, number[]> | null;
}

/** OpenAlex の要旨は転置インデックスなので語順を戻す */
export function rebuildAbstract(ii: Record<string, number[]> | null | undefined): string | null {
  if (!ii) return null;
  const slots: string[] = [];
  for (const [word, positions] of Object.entries(ii)) {
    for (const p of positions) slots[p] = word;
  }
  const text = slots.filter(Boolean).join(' ').trim();
  return text || null;
}

export async function handleQueueMessage(msg: CollectMessage, env: Env): Promise<void> {
  let papers: FetchedPaper[] = [];
  let failure: string | null = null;

  try {
    papers = await fetchFromSource(msg.source, msg.summary);
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }

  // FR-08 / C-07: 「0 件」と「取得失敗」を必ず分ける
  const status = failure ? 'failed' : papers.length === 0 ? 'empty' : 'ok';
  const failedJson = failure ? JSON.stringify([{ source: msg.source, error: failure }]) : null;

  const statements: D1PreparedStatement[] = [
    // 同じ日の再実行は同じ行に当たる。部分的に成功していた場合は partial へ倒す
    env.DB.prepare(
      `INSERT INTO runs (run_id, project_id, run_date, status, failed_sources_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (project_id, run_date) DO UPDATE SET
         status = CASE
           WHEN runs.status = excluded.status THEN runs.status
           ELSE 'partial'
         END,
         failed_sources_json = COALESCE(excluded.failed_sources_json, runs.failed_sources_json)`,
    ).bind(msg.run_id, msg.project_id, msg.run_date, status, failedJson),
  ];

  if (papers.length > 0) {
    // D1 は 1 実行 50 クエリまで。1 件ずつ INSERT せず複数行を 1 文にまとめる。
    // ただし 1 文あたりのバインド変数には上限があるので、まとめすぎると
    // "too many SQL variables" で落ちる。列数から逆算して収める。
    const CHUNK = Math.floor(D1_MAX_BIND_PARAMS / RUN_PAPER_COLUMNS);
    for (let i = 0; i < papers.length; i += CHUNK) {
      const chunk = papers.slice(i, i + CHUNK);
      const values = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const binds: unknown[] = [];
      for (const p of chunk) {
        binds.push(
          msg.run_id,
          p.external_id,
          msg.source,
          p.title,
          p.abstract,
          p.url,
          p.published_at,
          coarseScore(msg.summary, `${p.title} ${p.abstract ?? ''}`),
        );
      }
      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO run_papers
             (run_id, external_id, source, title, abstract, url, published_at, coarse_score)
           VALUES ${values}`,
        ).bind(...binds),
      );
    }
  }

  await env.DB.batch(statements);

  if (failure) throw new Error(failure); // 再試行させる。記録は済んでいる
}

/**
 * 粗い採点。**文字列一致の水準に留める**（ADR-0004）。
 * 埋め込みによる精密な採点はローカル（ADR-0001, C-09）
 */
export function coarseScore(summary: string, text: string): number {
  const terms = new Set(
    summary
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 4),
  );
  if (terms.size === 0) return 0;
  const hay = text.toLowerCase();
  let hit = 0;
  for (const t of terms) if (hay.includes(t)) hit++;
  return hit / terms.size;
}

// --- エントリポイント --------------------------------------------------------

export default {
  fetch: handleFetch,

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(env));
  },

  async queue(batch: MessageBatch<CollectMessage>, env: Env) {
    for (const message of batch.messages) {
      try {
        await handleQueueMessage(message.body, env);
        message.ack();
      } catch {
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, CollectMessage>;
