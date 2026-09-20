// ローカルストアへの操作。GUI からも CLI からもここだけを通す（FR-11）。
//
// 方針:
//   - 「未採点」と「採点して低かった」を混ぜない（C-07）
//   - 有効／除外の列を持たない。順位だけを出す（ADR-0001）

import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { toVectorBlob } from './db.js';

export interface Project {
  project_id: string;
  title: string;
  summary: string;
  embed_model: string;
  last_run_id: string | null;
}

export interface PaperInput {
  external_id: string;
  source: string;
  title: string;
  abstract: string | null;
  url?: string | null;
  published_at?: string | null;
  coarse_score?: number | null;
  run_id?: string | null;
}

export interface RankedPaper {
  paper_id: string;
  title: string;
  abstract: string | null;
  url: string | null;
  relevance: number | null;
  sim_summary: number | null;
  nearest_chunk_id: number | null;
  nearest_chunk_sim: number | null;
  nearest_chunk_text: string | null;
  scored_at: string | null;
  in_library: number;
}

/** blend の重み。実測で最良だった配分（prototypes/judge-bench/FINDINGS.md） */
export const BLEND_SUMMARY_WEIGHT = 0.7;
export const BLEND_CHUNK_WEIGHT = 0.3;

export function blendScore(simSummary: number, nearestChunkSim: number | null): number {
  return (
    BLEND_SUMMARY_WEIGHT * simSummary +
    BLEND_CHUNK_WEIGHT * (nearestChunkSim ?? simSummary)
  );
}

// --- プロジェクト -----------------------------------------------------------

export function createProject(
  db: Db,
  p: { title: string; summary: string; embed_model: string; project_id?: string },
): Project {
  const id = p.project_id ?? randomUUID();
  db.prepare(
    'INSERT INTO projects (project_id, title, summary, embed_model) VALUES (?, ?, ?, ?)',
  ).run(id, p.title, p.summary, p.embed_model);
  return { project_id: id, title: p.title, summary: p.summary, embed_model: p.embed_model, last_run_id: null };
}

export function getProject(db: Db, projectId: string): Project | undefined {
  return db
    .prepare('SELECT project_id, title, summary, embed_model, last_run_id FROM projects WHERE project_id = ?')
    .get(projectId) as Project | undefined;
}

export function listProjects(db: Db): Project[] {
  return db
    .prepare('SELECT project_id, title, summary, embed_model, last_run_id FROM projects ORDER BY created_at')
    .all() as unknown as Project[];
}

/**
 * 概要を書き換えると採点の前提が変わる。
 * **黙って古い順位を見せ続けない**ため、採点済みの印を落として採点し直させる（C-07）。
 */
export function updateSummary(db: Db, projectId: string, summary: string): void {
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE projects SET summary = ? WHERE project_id = ?').run(summary, projectId);
    db.prepare('UPDATE papers SET scored_at = NULL WHERE project_id = ?').run(projectId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// --- 自分の主張（原稿チャンク） ------------------------------------------------

/** 原稿を 1 本登録し、主張を chunks として入れる。既存の同一 document は置き換える */
export function setManuscript(
  db: Db,
  projectId: string,
  claims: { text: string; section?: string }[],
  documentId = `${projectId}:manuscript`,
): number[] {
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO documents (document_id, project_id, kind, format)
       VALUES (?, ?, 'manuscript', 'md')
       ON CONFLICT (document_id) DO UPDATE SET updated_at = datetime('now')`,
    ).run(documentId, projectId);

    // 入れ替えなので古いチャンクは消す。vec_chunks も追随させる
    const old = db
      .prepare('SELECT chunk_id FROM chunks WHERE document_id = ?')
      .all(documentId) as unknown as { chunk_id: number }[];
    for (const c of old) {
      db.prepare('DELETE FROM vec_chunks WHERE rowid = ?').run(BigInt(c.chunk_id));
    }
    db.prepare('DELETE FROM chunks WHERE document_id = ?').run(documentId);

    const ids: number[] = [];
    const ins = db.prepare('INSERT INTO chunks (document_id, section, text) VALUES (?, ?, ?)');
    for (const c of claims) {
      const r = ins.run(documentId, c.section ?? null, c.text);
      ids.push(Number(r.lastInsertRowid));
    }

    // 主張が変われば採点の前提も変わる
    db.prepare('UPDATE papers SET scored_at = NULL WHERE project_id = ?').run(projectId);
    db.exec('COMMIT');
    return ids;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function listChunks(db: Db, projectId: string): { chunk_id: number; text: string }[] {
  return db
    .prepare(
      `SELECT c.chunk_id, c.text FROM chunks c
       JOIN documents d ON d.document_id = c.document_id
       WHERE d.project_id = ? AND d.kind = 'manuscript'
       ORDER BY c.chunk_id`,
    )
    .all(projectId) as unknown as { chunk_id: number; text: string }[];
}

export function setChunkEmbedding(db: Db, chunkId: number, vec: Float32Array): void {
  db.prepare('INSERT OR REPLACE INTO vec_chunks (rowid, embedding) VALUES (?, ?)').run(
    BigInt(chunkId),
    toVectorBlob(vec),
  );
}

// --- 論文 -------------------------------------------------------------------

/** 同期で取り込む。既にある論文は上書きしない（採点をやり直させない） */
export function upsertPapers(db: Db, projectId: string, papers: PaperInput[]): number {
  let inserted = 0;
  db.exec('BEGIN');
  try {
    const ins = db.prepare(
      `INSERT INTO papers
         (paper_id, project_id, run_id, external_id, source, title, abstract, url, published_at, coarse_score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, source, external_id) DO NOTHING`,
    );
    for (const p of papers) {
      const r = ins.run(
        randomUUID(),
        projectId,
        p.run_id ?? null,
        p.external_id,
        p.source,
        p.title,
        p.abstract ?? null,
        p.url ?? null,
        p.published_at ?? null,
        p.coarse_score ?? null,
      );
      inserted += Number(r.changes);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return inserted;
}

/** 未採点の論文。採点キュー表を作らずこれで再開する（NFR-06） */
export function listUnscored(db: Db, projectId: string, limit = 500) {
  return db
    .prepare(
      `SELECT paper_id, title, abstract FROM papers
       WHERE project_id = ? AND scored_at IS NULL
       ORDER BY published_at DESC NULLS LAST, rowid
       LIMIT ?`,
    )
    .all(projectId, limit) as unknown as {
    paper_id: string;
    title: string;
    abstract: string | null;
  }[];
}

/** 1 件ずつ確定させる。途中で終了しても済んだ分は残る（NFR-06） */
export function saveScore(
  db: Db,
  paperId: string,
  score: {
    relevance: number;
    sim_summary: number;
    nearest_chunk_id: number | null;
    nearest_chunk_sim: number | null;
    embed_model: string;
  },
): void {
  db.prepare(
    `UPDATE papers SET
       relevance = ?, sim_summary = ?, nearest_chunk_id = ?, nearest_chunk_sim = ?,
       embed_model = ?, scored_at = datetime('now')
     WHERE paper_id = ?`,
  ).run(
    score.relevance,
    score.sim_summary,
    score.nearest_chunk_id,
    score.nearest_chunk_sim,
    score.embed_model,
    paperId,
  );
}

/**
 * 関連度順。**未採点は混ぜない。**
 * 順位が付いていないものを上位や下位に紛れ込ませると、採点漏れに気づけない（C-07）。
 */
export function listRanked(db: Db, projectId: string, limit = 100): RankedPaper[] {
  return db
    .prepare(
      `SELECT p.paper_id, p.title, p.abstract, p.url, p.relevance, p.sim_summary,
              p.nearest_chunk_id, p.nearest_chunk_sim, c.text AS nearest_chunk_text,
              p.scored_at, p.in_library
       FROM papers p
       LEFT JOIN chunks c ON c.chunk_id = p.nearest_chunk_id
       WHERE p.project_id = ? AND p.scored_at IS NOT NULL
       ORDER BY p.relevance DESC
       LIMIT ?`,
    )
    .all(projectId, limit) as unknown as RankedPaper[];
}

/** 「未採点 n 件」を実数で出すため。推定しない */
export function countUnscored(db: Db, projectId: string): number {
  const r = db
    .prepare('SELECT COUNT(*) AS n FROM papers WHERE project_id = ? AND scored_at IS NULL')
    .get(projectId) as { n: number };
  return r.n;
}

// --- ライブラリ ---------------------------------------------------------------

/** 著者姓＋年。衝突は英字サフィックス（ADR-0003） */
export function makeBibtexKey(db: Db, projectId: string, authors: string, year: number | null): string {
  const surname =
    (authors.split(/[,;]/)[0] ?? '')
      .trim()
      .split(/\s+/)
      .pop()
      ?.replace(/[^A-Za-z]/g, '') || 'anon';
  const base = `${surname.toLowerCase()}${year ?? 'nd'}`;
  const taken = new Set(
    (
      db
        .prepare('SELECT bibtex_key FROM reference_items WHERE project_id = ? AND bibtex_key LIKE ?')
        .all(projectId, `${base}%`) as unknown as { bibtex_key: string }[]
    ).map((r) => r.bibtex_key),
  );
  if (!taken.has(base)) return base;
  for (let i = 0; i < 26; i++) {
    const k = base + String.fromCharCode(97 + i);
    if (!taken.has(k)) return k;
  }
  return `${base}-${randomUUID().slice(0, 6)}`;
}

export function addToLibrary(
  db: Db,
  projectId: string,
  item: { paper_id?: string | null; title: string; authors?: string; year?: number | null; doi?: string | null; url?: string | null },
): string {
  const refId = randomUUID();
  const key = makeBibtexKey(db, projectId, item.authors ?? '', item.year ?? null);
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO reference_items (reference_id, project_id, paper_id, title, authors, year, doi, url, bibtex_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      refId,
      projectId,
      item.paper_id ?? null,
      item.title,
      item.authors ?? null,
      item.year ?? null,
      item.doi ?? null,
      item.url ?? null,
      key,
    );
    if (item.paper_id) {
      db.prepare('UPDATE papers SET in_library = 1 WHERE paper_id = ?').run(item.paper_id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return refId;
}

export function listLibrary(db: Db, projectId: string) {
  return db
    .prepare(
      `SELECT reference_id, title, authors, year, doi, url, bibtex_key, added_at
       FROM reference_items WHERE project_id = ? ORDER BY added_at DESC`,
    )
    .all(projectId) as unknown as {
    reference_id: string;
    title: string;
    authors: string | null;
    year: number | null;
    doi: string | null;
    url: string | null;
    bibtex_key: string;
    added_at: string;
  }[];
}
