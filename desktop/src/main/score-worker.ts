// 採点ワーカー。**utilityProcess で動く**（ADR-0001 / NFR-06）。
//
// レンダラでもメインプロセスでも回さない:
//   - レンダラで回すと UI が固まる
//   - メインで回すとウィンドウのイベント処理が止まる
//
// 親とは message でやり取りし、DB へは 1 件ごとに確定させる。
// 途中で殺されても済んだ分は残る。

import { openDb } from '../shared/db.js';
import { scoreProject } from '../shared/scorer.js';
import { createEmbedder } from '../shared/scorer.js';

export interface ScoreRequest {
  type: 'score';
  dbPath: string;
  projectId: string;
  model: string;
  cacheDir?: string;
  limit?: number;
}

export type ScoreEvent =
  | { type: 'progress'; done: number; total: number }
  | { type: 'done'; scored: number }
  // 失敗を握りつぶして「0 件採点した」に見せない（C-07）
  | { type: 'error'; message: string };

const send = (e: ScoreEvent) => process.parentPort?.postMessage(e);

let aborter: AbortController | null = null;

process.parentPort?.on('message', async (ev) => {
  const msg = ev.data as ScoreRequest | { type: 'cancel' };

  if (msg.type === 'cancel') {
    aborter?.abort();
    return;
  }

  if (msg.type !== 'score') return;

  aborter = new AbortController();
  let db;
  try {
    db = openDb({ path: msg.dbPath });
    const embedder = await createEmbedder(msg.model, msg.cacheDir);
    const scored = await scoreProject(db, msg.projectId, embedder, {
      limit: msg.limit,
      signal: aborter.signal,
      onProgress: (p) => send({ type: 'progress', done: p.done, total: p.total }),
    });
    send({ type: 'done', scored });
  } catch (e) {
    send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  } finally {
    db?.close();
  }
});
