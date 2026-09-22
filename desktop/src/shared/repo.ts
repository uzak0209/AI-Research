// ローカルストアへの操作。GUI からも CLI からもここだけを通す（FR-11）。
//
// 方針:
//   - 「未採点」と「採点して低かった」を混ぜない（C-07）
//   - 有効／除外の列を持たない。順位だけを出す（ADR-0001）

import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { EMBED_DIM, toVectorBlob } from './db.js';

export interface Project {
  project_id: string;
  title: string;
  summary: string;
  embed_model: string;
  last_run_id: string | null;
  last_search_terms: string | null;
  root_path: string | null;
}

export interface PaperInput {
  external_id: string;
  source: string;
  title: string;
  authors?: string | null;
  abstract: string | null;
  url?: string | null;
  published_at?: string | null;
  /** 掲載誌・会議名。候補の時点で揃う（書誌補完を呼ばないため） */
  venue?: string | null;
  item_type?: string | null;
  /** 収集時に取れた OA 直 PDF。後から引き直さない */
  pdf_url?: string | null;
  coarse_score?: number | null;
  problem_excerpt?: string | null;
  run_id?: string | null;
}

export interface RankedPaper {
  paper_id: string;
  external_id: string | null;
  title: string;
  authors: string | null;
  abstract: string | null;
  url: string | null;
  published_at: string | null;
  relevance: number | null;
  sim_summary: number | null;
  nearest_chunk_id: number | null;
  nearest_chunk_sim: number | null;
  nearest_chunk_text: string | null;
  scored_at: string | null;
  in_library: number;
  problem_excerpt: string | null;
  venue?: string | null;
  item_type?: string | null;
  /** OA 直 PDF の有無。無ければ「未取得」と出す（C-07） */
  pdf_url?: string | null;
  /** 手元に落ちている PDF のパス。無ければ null */
  fulltext_path?: string | null;
}

/** published_at（YYYY-MM-DD）から年だけ。形が崩れていたら null（C-07） */
export function yearFromPublishedAt(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const y = Number(String(raw).slice(0, 4));
  return Number.isInteger(y) && y >= 1000 && y <= 2100 ? y : null;
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

const PROJECT_COLS =
  'project_id, title, summary, embed_model, last_run_id, last_search_terms, root_path';

export function createProject(
  db: Db,
  p: { title: string; summary: string; embed_model: string; project_id?: string; root_path?: string | null },
): Project {
  const id = p.project_id ?? randomUUID();
  db.prepare(
    'INSERT INTO projects (project_id, title, summary, embed_model, root_path) VALUES (?, ?, ?, ?, ?)',
  ).run(id, p.title, p.summary, p.embed_model, p.root_path ?? null);
  return {
    project_id: id,
    title: p.title,
    summary: p.summary,
    embed_model: p.embed_model,
    last_run_id: null,
    last_search_terms: null,
    root_path: p.root_path ?? null,
  };
}

export function getProject(db: Db, projectId: string): Project | undefined {
  return db
    .prepare(`SELECT ${PROJECT_COLS} FROM projects WHERE project_id = ?`)
    .get(projectId) as Project | undefined;
}

export function listProjects(db: Db): Project[] {
  return db
    .prepare(`SELECT ${PROJECT_COLS} FROM projects ORDER BY created_at DESC`)
    .all() as unknown as Project[];
}

export function updateTitle(db: Db, projectId: string, title: string): void {
  db.prepare('UPDATE projects SET title = ? WHERE project_id = ?').run(title, projectId);
}

export function setProjectRoot(db: Db, projectId: string, rootPath: string): void {
  db.prepare('UPDATE projects SET root_path = ? WHERE project_id = ?').run(rootPath, projectId);
}

/**
 * 課題意識を書き換えると採点の前提が変わる。
 * **黙って古い順位を見せ続けない**ため、採点済みの印を落として採点し直させる（C-07）。
 */
export function setLastRunId(db: Db, projectId: string, runId: string | null): void {
  db.prepare('UPDATE projects SET last_run_id = ? WHERE project_id = ?').run(runId, projectId);
}

export function parseSearchTerms(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((s) => s.trim());
  } catch {
    return [];
  }
}

export function setLastSearchTerms(db: Db, projectId: string, terms: string[]): void {
  db.prepare('UPDATE projects SET last_search_terms = ? WHERE project_id = ?').run(
    JSON.stringify(terms),
    projectId,
  );
}

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

// --- 関連技術（プロフィール chunks） ------------------------------------------------

/** 関連技術を 1 本の document として入れ替える。既存の同一 document は置き換える */
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

    // 関連技術が変われば採点の前提も変わる
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

export function getChunkEmbedding(db: Db, chunkId: number): Float32Array | null {
  const row = db
    .prepare('SELECT embedding FROM vec_chunks WHERE rowid = ?')
    .get(BigInt(chunkId)) as { embedding: unknown } | undefined;
  if (!row) return null;
  return blobToVec(row.embedding);
}

/**
 * sqlite-vec の vec0 は INSERT OR REPLACE / UPDATE を受け付けない。
 * 同じ rowid をもう一度 INSERT すると UNIQUE constraint で落ちるので、消してから入れる。
 */
export function setChunkEmbedding(db: Db, chunkId: number, vec: Float32Array): void {
  const id = BigInt(chunkId);
  const blob = toVectorBlob(vec);
  db.prepare('DELETE FROM vec_chunks WHERE rowid = ?').run(id);
  db.prepare('INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)').run(id, blob);
}

function blobToVec(raw: unknown): Float32Array {
  let bytes: Uint8Array;
  if (raw instanceof Uint8Array) {
    bytes = raw;
  } else if (raw instanceof ArrayBuffer) {
    bytes = new Uint8Array(raw);
  } else {
    throw new Error(`vec_chunks の埋め込みの型が読めない: ${typeof raw}`);
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const vec = new Float32Array(copy.buffer);
  if (vec.length !== EMBED_DIM) {
    throw new Error(`埋め込みの次元が違う: ${vec.length}（期待 ${EMBED_DIM}）`);
  }
  return vec;
}

// --- 論文 -------------------------------------------------------------------

/** 同期で取り込む。既にある論文は上書きしない（採点をやり直させない） */
export function upsertPapers(db: Db, projectId: string, papers: PaperInput[]): number {
  let inserted = 0;
  db.exec('BEGIN');
  try {
    const ins = db.prepare(
      `INSERT INTO papers
         (paper_id, project_id, run_id, external_id, source, title, authors, abstract, url, published_at,
          venue, item_type, pdf_url, coarse_score, problem_excerpt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, source, external_id) DO NOTHING`,
    );
    const fillAuthors = db.prepare(
      `UPDATE papers SET authors = ?
        WHERE project_id = ? AND source = ? AND external_id = ?
          AND (authors IS NULL OR trim(authors) = '')
          AND ? IS NOT NULL`,
    );
    // 既存行にも後から来た OA 直 PDF を入れる。既にあるものは触らない
    const fillPdfUrl = db.prepare(
      `UPDATE papers SET pdf_url = ?
        WHERE project_id = ? AND source = ? AND external_id = ?
          AND (pdf_url IS NULL OR trim(pdf_url) = '')`,
    );
    for (const p of papers) {
      const r = ins.run(
        randomUUID(),
        projectId,
        p.run_id ?? null,
        p.external_id,
        p.source,
        p.title,
        p.authors ?? null,
        p.abstract ?? null,
        p.url ?? null,
        p.published_at ?? null,
        p.venue ?? null,
        p.item_type ?? null,
        p.pdf_url ?? null,
        p.coarse_score ?? null,
        p.problem_excerpt ?? null,
      );
      inserted += Number(r.changes);
      if (p.authors?.trim()) {
        fillAuthors.run(p.authors.trim(), projectId, p.source, p.external_id, p.authors.trim());
      }
      if (p.pdf_url?.trim()) {
        fillPdfUrl.run(p.pdf_url.trim(), projectId, p.source, p.external_id);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return inserted;
}

/** 未採点の論文。採点キュー表を作らずこれで再開する（NFR-06） */
export function listUnscored(
  db: Db,
  projectId: string,
  limit = 500,
  opts: { requireFulltext?: boolean } = {},
) {
  const requireFulltext = opts.requireFulltext === true;
  return db
    .prepare(
      `SELECT paper_id, title, abstract, fulltext, fulltext_path
       FROM papers
       WHERE project_id = ? AND scored_at IS NULL
         ${requireFulltext ? "AND fulltext IS NOT NULL AND trim(fulltext) != ''" : ''}
       ORDER BY published_at DESC NULLS LAST, rowid
       LIMIT ?`,
    )
    .all(projectId, limit) as unknown as {
    paper_id: string;
    title: string;
    abstract: string | null;
    fulltext: string | null;
    fulltext_path: string | null;
  }[];
}

/** mypaper あり時: 本文が無くて採点できない件数（実数。C-07） */
export function countUnscoredMissingFulltext(db: Db, projectId: string): number {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS n FROM papers
       WHERE project_id = ? AND scored_at IS NULL
         AND (fulltext IS NULL OR trim(fulltext) = '')`,
    )
    .get(projectId) as { n: number };
  return r.n;
}

export function listPapersNeedingFulltext(db: Db, projectId: string, limit = 200) {
  return db
    .prepare(
      `SELECT paper_id, title, abstract, url, external_id, pdf_url, fulltext_path
       FROM papers
       WHERE project_id = ? AND scored_at IS NULL
         AND (fulltext IS NULL OR trim(fulltext) = '')
         AND in_library = 0
       ORDER BY published_at DESC NULLS LAST, rowid
       LIMIT ?`,
    )
    .all(projectId, limit) as unknown as {
    paper_id: string;
    title: string;
    abstract: string | null;
    url: string | null;
    external_id: string | null;
    pdf_url: string | null;
    fulltext_path: string | null;
  }[];
}

export function setPaperPdfUrl(db: Db, paperId: string, pdfUrl: string): void {
  db.prepare('UPDATE papers SET pdf_url = ? WHERE paper_id = ?').run(pdfUrl, paperId);
}

export function setPaperFulltext(
  db: Db,
  paperId: string,
  data: { path: string; text: string },
): void {
  db.prepare(
    'UPDATE papers SET fulltext_path = ?, fulltext = ? WHERE paper_id = ?',
  ).run(data.path, data.text, paperId);
}

export function getPaperFulltextRow(
  db: Db,
  paperId: string,
): { fulltext_path: string | null; fulltext: string | null; pdf_url: string | null } | undefined {
  return db
    .prepare('SELECT fulltext_path, fulltext, pdf_url FROM papers WHERE paper_id = ?')
    .get(paperId) as
    | { fulltext_path: string | null; fulltext: string | null; pdf_url: string | null }
    | undefined;
}

/** 著者が空の候補。PDF / 本文があれば LLM に 1 ページ目を読ませる */
export function listPapersMissingAuthors(db: Db, projectId: string, limit = 40) {
  return db
    .prepare(
      `SELECT paper_id, title, url, external_id, pdf_url, fulltext_path, fulltext
       FROM papers
       WHERE project_id = ?
         AND in_library = 0
         AND (authors IS NULL OR trim(authors) = '')
       ORDER BY published_at DESC NULLS LAST, rowid
       LIMIT ?`,
    )
    .all(projectId, limit) as unknown as {
    paper_id: string;
    title: string;
    url: string | null;
    external_id: string | null;
    pdf_url: string | null;
    fulltext_path: string | null;
    fulltext: string | null;
  }[];
}

/** 空の authors だけ埋める。既にある値は消さない */
export function fillPaperAuthors(db: Db, paperId: string, authors: string): boolean {
  const t = authors.trim();
  if (!t) return false;
  const r = db
    .prepare(
      `UPDATE papers SET authors = ?
        WHERE paper_id = ?
          AND (authors IS NULL OR trim(authors) = '')`,
    )
    .run(t, paperId);
  return Number(r.changes) > 0;
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
 * 関連度順。**未採点は混ぜない。ライブラリ済も出さない。**
 * 順位が付いていないものを上位や下位に紛れ込ませると、採点漏れに気づけない（C-07）。
 */
export function listRanked(db: Db, projectId: string, limit = 100): RankedPaper[] {
  return db
    .prepare(
      `SELECT p.paper_id, p.external_id, p.title, p.authors, p.abstract, p.url, p.published_at,
              p.relevance, p.sim_summary,
              p.nearest_chunk_id, p.nearest_chunk_sim, c.text AS nearest_chunk_text,
              p.scored_at, p.in_library, p.problem_excerpt, p.venue, p.item_type, p.pdf_url, p.fulltext_path
       FROM papers p
       LEFT JOIN chunks c ON c.chunk_id = p.nearest_chunk_id
       WHERE p.project_id = ? AND p.scored_at IS NOT NULL AND p.in_library = 0
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

export interface SurveyReport {
  run_id: string;
  project_id: string;
  run_date: string;
  status: string;
  search_terms: string | null;
  trend: string | null;
  themes_json: string | null;
  failed_sources: string | null;
  created_at: string;
  paper_count: number;
}

export function failedSourcesText(raw: string | null | undefined): string | null {
  const t = raw?.trim();
  if (!t) return null;
  try {
    const parsed: unknown = JSON.parse(t);
    if (!Array.isArray(parsed)) return t;
    const parts: string[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const err = (item as { error?: unknown }).error;
      if (typeof err === 'string' && err.trim()) parts.push(err.trim());
    }
    return parts.length ? parts.join(' / ') : t;
  } catch {
    return t;
  }
}

export function upsertSurveyReport(
  db: Db,
  row: {
    run_id: string;
    project_id: string;
    run_date: string;
    status: string;
    search_terms?: string[];
    trend?: string | null;
    themes?: string[];
    failed_sources?: string | null;
    created_at: string;
  },
): void {
  db.prepare(
    `INSERT INTO survey_reports (run_id, project_id, run_date, status, search_terms, trend, themes_json, failed_sources, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (run_id) DO UPDATE SET
       status = excluded.status,
       search_terms = COALESCE(excluded.search_terms, survey_reports.search_terms),
       trend = COALESCE(excluded.trend, survey_reports.trend),
       themes_json = COALESCE(excluded.themes_json, survey_reports.themes_json),
       failed_sources = COALESCE(excluded.failed_sources, survey_reports.failed_sources)`,
  ).run(
    row.run_id,
    row.project_id,
    row.run_date,
    row.status,
    row.search_terms?.length ? JSON.stringify(row.search_terms) : null,
    row.trend ?? null,
    row.themes?.length ? JSON.stringify(row.themes) : null,
    row.failed_sources ?? null,
    row.created_at,
  );
}

export function listSurveyReports(db: Db, projectId: string): SurveyReport[] {
  return db
    .prepare(
      `SELECT r.run_id, r.project_id, r.run_date, r.status, r.search_terms, r.trend, r.themes_json, r.failed_sources, r.created_at,
              (SELECT COUNT(*) FROM papers p WHERE p.project_id = r.project_id AND p.run_id = r.run_id AND p.in_library = 0) AS paper_count
       FROM survey_reports r
       WHERE r.project_id = ?
       ORDER BY r.run_date DESC, r.created_at DESC`,
    )
    .all(projectId) as unknown as SurveyReport[];
}

export function getSurveyReport(db: Db, runId: string): SurveyReport | undefined {
  return db
    .prepare(
      `SELECT r.run_id, r.project_id, r.run_date, r.status, r.search_terms, r.trend, r.themes_json, r.failed_sources, r.created_at,
              (SELECT COUNT(*) FROM papers p WHERE p.project_id = r.project_id AND p.run_id = r.run_id AND p.in_library = 0) AS paper_count
       FROM survey_reports r
       WHERE r.run_id = ?`,
    )
    .get(runId) as SurveyReport | undefined;
}

export function listPapersForRun(db: Db, projectId: string, runId: string): RankedPaper[] {
  return db
    .prepare(
      `SELECT p.paper_id, p.external_id, p.title, p.authors, p.abstract, p.url, p.published_at,
              p.relevance, p.sim_summary,
              p.nearest_chunk_id, p.nearest_chunk_sim, c.text AS nearest_chunk_text,
              p.scored_at, p.in_library, p.problem_excerpt, p.venue, p.item_type, p.pdf_url, p.fulltext_path
       FROM papers p
       LEFT JOIN chunks c ON c.chunk_id = p.nearest_chunk_id
       WHERE p.project_id = ? AND p.run_id = ? AND p.in_library = 0
       ORDER BY p.relevance DESC NULLS LAST, p.published_at DESC NULLS LAST, p.rowid`,
    )
    .all(projectId, runId) as unknown as RankedPaper[];
}

/**
 * トレンドが無い報告。取り直しの対象。
 * 生の JSON が入った行（出力が切れて壊れたもの）も未着として扱い、取り直させる。
 */
export function reportsMissingTrend(db: Db, projectId: string): SurveyReport[] {
  return db
    .prepare(
      `SELECT r.run_id, r.project_id, r.run_date, r.status, r.search_terms, r.trend, r.themes_json, r.failed_sources, r.created_at,
              (SELECT COUNT(*) FROM papers p WHERE p.project_id = r.project_id AND p.run_id = r.run_id AND p.in_library = 0) AS paper_count
       FROM survey_reports r
       WHERE r.project_id = ?
         AND (r.trend IS NULL OR trim(r.trend) = ''
              OR (trim(r.trend) LIKE '{%' AND trim(r.trend) LIKE '%"trend"%'))
         AND (SELECT COUNT(*) FROM papers p WHERE p.project_id = r.project_id AND p.run_id = r.run_id) > 0
       ORDER BY r.run_date DESC
       LIMIT 5`,
    )
    .all(projectId) as unknown as SurveyReport[];
}
