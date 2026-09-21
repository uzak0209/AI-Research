// 関連度の採点。ADR-0001 の 2 段目だけを行い、生成 LLM は使わない。
//
// 優先: mypaper/ 原稿チャンク ↔ 候補 PDF 本文チャンクの max cos。
// フォールバック（mypaper 空）: blend = 課題意識 cos × 0.7 ＋ 最近傍の関連技術 cos × 0.3。
//
// **この処理はレンダラで回さない。** utilityProcess から呼ぶ（NFR-06）。

import type { Db } from './db.js';
import { EMBED_DIM, cosine } from './db.js';
import { loadMypaperChunks } from './mypaper.js';
import {
  blendScore,
  getChunkEmbedding,
  getProject,
  listChunks,
  listUnscored,
  saveScore,
  setChunkEmbedding,
} from './repo.js';
import { chunkText } from './text-chunk.js';

/** 埋め込みを作るもの。実体は Transformers.js だが、テストで差し替えられるようにする */
export interface Embedder {
  readonly model: string;
  embed(text: string): Promise<Float32Array>;
}

export interface ScoreProgress {
  done: number;
  total: number;
  paperId: string;
}

export type ScoreMode = 'mypaper' | 'blend';

/**
 * Transformers.js の埋め込み。ONNX Runtime 上で動き、追加ランタイムを増やさない（NFR-05）。
 * モデル名は設定から渡す。コードに埋めない（C-05）。
 */
export async function createEmbedder(model: string, cacheDir?: string): Promise<Embedder> {
  const { pipeline, env } = await import('@huggingface/transformers');
  if (cacheDir) env.cacheDir = cacheDir;

  const extract = await pipeline('feature-extraction', model);

  return {
    model,
    async embed(text: string) {
      const out = await extract(text, { pooling: 'mean', normalize: true });
      const v = Float32Array.from(out.data as ArrayLike<number>);
      if (v.length !== EMBED_DIM) {
        throw new Error(
          `モデル ${model} の次元 ${v.length} が想定 ${EMBED_DIM} と違う。EMBED_DIM か モデルを合わせること。`,
        );
      }
      return v;
    },
  };
}

async function embedChunks(embedder: Embedder, texts: string[]): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (const t of texts) {
    out.push(await embedder.embed(t));
  }
  return out;
}

/** チャンク集合同士の最大 cos */
export function maxPairwiseCos(a: Float32Array[], b: Float32Array[]): number {
  let best = -Infinity;
  for (const x of a) {
    for (const y of b) {
      const s = cosine(x, y);
      if (s > best) best = s;
    }
  }
  return best === -Infinity ? 0 : best;
}

/** 原稿全体との平均 cos（UI の「原稿との近さ」用） */
function meanMaxCos(mypaper: Float32Array[], paper: Float32Array[]): number {
  if (mypaper.length === 0 || paper.length === 0) return 0;
  let sum = 0;
  for (const m of mypaper) {
    let best = -Infinity;
    for (const p of paper) {
      const s = cosine(m, p);
      if (s > best) best = s;
    }
    sum += best === -Infinity ? 0 : best;
  }
  return sum / mypaper.length;
}

/**
 * 未採点の論文を採点する。**1 件ごとに DB へ確定させる。**
 * 途中で終了しても済んだ分は残り、残りは未採点のまま次回に回る（NFR-06）。
 *
 * @returns 採点した件数
 */
export async function scoreProject(
  db: Db,
  projectId: string,
  embedder: Embedder,
  opts: { limit?: number; onProgress?: (p: ScoreProgress) => void; signal?: AbortSignal } = {},
): Promise<number> {
  const project = getProject(db, projectId);
  if (!project) throw new Error(`プロジェクトが無い: ${projectId}`);
  if (project.embed_model !== embedder.model) {
    throw new Error(
      `埋め込みモデルが違う: プロジェクトは ${project.embed_model}、渡されたのは ${embedder.model}`,
    );
  }

  const mypaperTexts = loadMypaperChunks(project.root_path);
  if (mypaperTexts.length > 0) {
    return scoreWithMypaper(db, projectId, embedder, mypaperTexts, opts);
  }
  return scoreWithBlend(db, projectId, embedder, project.summary, opts);
}

async function scoreWithMypaper(
  db: Db,
  projectId: string,
  embedder: Embedder,
  mypaperTexts: string[],
  opts: { limit?: number; onProgress?: (p: ScoreProgress) => void; signal?: AbortSignal },
): Promise<number> {
  const mypaperVecs = await embedChunks(embedder, mypaperTexts);
  // PDF 本文があるものだけ。無いものは scored_at を付けず未採点のまま
  const papers = listUnscored(db, projectId, opts.limit ?? 500, { requireFulltext: true });
  let done = 0;

  for (const p of papers) {
    if (opts.signal?.aborted) break;
    const paperChunks = chunkText(p.fulltext ?? '');
    if (paperChunks.length === 0) continue;

    const paperVecs = await embedChunks(embedder, paperChunks);
    const relevance = maxPairwiseCos(mypaperVecs, paperVecs);
    const simSummary = meanMaxCos(mypaperVecs, paperVecs);

    saveScore(db, p.paper_id, {
      relevance,
      sim_summary: simSummary,
      nearest_chunk_id: null,
      nearest_chunk_sim: null,
      embed_model: embedder.model,
    });

    done++;
    opts.onProgress?.({ done, total: papers.length, paperId: p.paper_id });
  }

  return done;
}

async function scoreWithBlend(
  db: Db,
  projectId: string,
  embedder: Embedder,
  summary: string,
  opts: { limit?: number; onProgress?: (p: ScoreProgress) => void; signal?: AbortSignal },
): Promise<number> {
  const summaryVec = await embedder.embed(summary);

  const chunks = listChunks(db, projectId);
  const chunkVecs: { chunk_id: number; vec: Float32Array }[] = [];
  for (const c of chunks) {
    const existing = getChunkEmbedding(db, c.chunk_id);
    const vec = existing ?? (await embedder.embed(c.text));
    if (!existing) setChunkEmbedding(db, c.chunk_id, vec);
    chunkVecs.push({ chunk_id: c.chunk_id, vec });
  }

  const papers = listUnscored(db, projectId, opts.limit ?? 500);
  let done = 0;

  for (const p of papers) {
    if (opts.signal?.aborted) break;

    const vec = await embedder.embed(`${p.title}\n${p.abstract ?? ''}`);
    const simSummary = cosine(summaryVec, vec);

    let nearest: { chunk_id: number; sim: number } | null = null;
    for (const c of chunkVecs) {
      const sim = cosine(c.vec, vec);
      if (!nearest || sim > nearest.sim) nearest = { chunk_id: c.chunk_id, sim };
    }

    saveScore(db, p.paper_id, {
      relevance: blendScore(simSummary, nearest?.sim ?? null),
      sim_summary: simSummary,
      nearest_chunk_id: nearest?.chunk_id ?? null,
      nearest_chunk_sim: nearest?.sim ?? null,
      embed_model: embedder.model,
    });

    done++;
    opts.onProgress?.({ done, total: papers.length, paperId: p.paper_id });
  }

  return done;
}
