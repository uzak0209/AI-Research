// 関連度の採点。ADR-0001 の 2 段目だけを行い、生成 LLM は使わない。
//
// 採点式は blend = 概要 cos × 0.7 ＋ 最近傍チャンク cos × 0.3。
// 実測の根拠は prototypes/judge-bench/FINDINGS.md。
//
// **この処理はレンダラで回さない。** utilityProcess から呼ぶ（NFR-06）。
// 1 件 80 ms 程度かかるため、UI と同じスレッドに置くと操作を塞ぐ。

import type { Db } from './db.js';
import { EMBED_DIM, cosine } from './db.js';
import {
  blendScore,
  getProject,
  listChunks,
  listUnscored,
  saveScore,
  setChunkEmbedding,
} from './repo.js';

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
        // 次元が合わないモデルを黙って使うと検索が静かに壊れる
        throw new Error(
          `モデル ${model} の次元 ${v.length} が想定 ${EMBED_DIM} と違う。EMBED_DIM か モデルを合わせること。`,
        );
      }
      return v;
    },
  };
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
    // 別モデルのベクトルは比較できない（ADR-0001）
    throw new Error(
      `埋め込みモデルが違う: プロジェクトは ${project.embed_model}、渡されたのは ${embedder.model}`,
    );
  }

  const summaryVec = await embedder.embed(project.summary);

  // 自分の主張のベクトル。未計算のものだけ埋める
  const chunks = listChunks(db, projectId);
  const chunkVecs: { chunk_id: number; vec: Float32Array }[] = [];
  for (const c of chunks) {
    const vec = await embedder.embed(c.text);
    setChunkEmbedding(db, c.chunk_id, vec);
    chunkVecs.push({ chunk_id: c.chunk_id, vec });
  }

  const papers = listUnscored(db, projectId, opts.limit ?? 500);
  let done = 0;

  for (const p of papers) {
    if (opts.signal?.aborted) break;

    const vec = await embedder.embed(`${p.title}\n${p.abstract ?? ''}`);
    const simSummary = cosine(summaryVec, vec);

    // 自分のどの主張に最も近いか。最近傍という**事実**であって判定ではない
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
