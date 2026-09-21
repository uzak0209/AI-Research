// 参考文献ライブラリの操作（FR-05 / FR-14）。
// 自分で保存し、読み、印を付け、メモを書ける。外部マネージャに依存しない（ADR-0003）。
//
// ここも GUI と CLI が共有する（FR-11）。

import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { makeBibtexKey } from './repo.js';

export type ReadStatus = 'unread' | 'reading' | 'read';

/** node:sqlite に渡せる値 */
type SqlValue = string | number | bigint | null | Uint8Array;

export interface ReferenceInput {
  title: string;
  authors?: string | null;
  year?: number | null;
  doi?: string | null;
  url?: string | null;
  venue?: string | null;
  abstract?: string | null;
  item_type?: string;
  paper_id?: string | null;
}

export interface ReferenceRow {
  reference_id: string;
  paper_id: string | null;
  title: string;
  authors: string | null;
  year: number | null;
  doi: string | null;
  url: string | null;
  venue: string | null;
  abstract: string | null;
  item_type: string;
  starred: number;
  read_status: ReadStatus;
  bibtex_key: string;
  added_at: string;
  updated_at: string | null;
  tags: string[];
  has_note: number;
  attachment_count: number;
}

export interface LibraryFilter {
  /** タイトル・著者・掲載誌・メモの部分一致 */
  query?: string;
  starred?: boolean;
  readStatus?: ReadStatus;
  tag?: string;
  sort?: 'added' | 'year' | 'title';
}

// --- 追加・更新・削除 ---------------------------------------------------------

export function addReference(db: Db, projectId: string, item: ReferenceInput): string {
  const refId = randomUUID();
  const key = makeBibtexKey(db, projectId, item.authors ?? '', item.year ?? null);

  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO reference_items
         (reference_id, project_id, paper_id, title, authors, year, doi, url, venue, abstract, item_type, bibtex_key, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(
      refId,
      projectId,
      item.paper_id ?? null,
      item.title,
      item.authors ?? null,
      item.year ?? null,
      item.doi ?? null,
      item.url ?? null,
      item.venue ?? null,
      item.abstract ?? null,
      item.item_type ?? 'article',
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

const EDITABLE = ['title', 'authors', 'year', 'doi', 'url', 'venue', 'abstract', 'item_type'] as const;

export function updateReference(db: Db, referenceId: string, patch: Partial<ReferenceInput>): void {
  const sets: string[] = [];
  const vals: SqlValue[] = [];
  for (const k of EDITABLE) {
    if (k in patch) {
      sets.push(`${k} = ?`);
      vals.push(((patch as Record<string, unknown>)[k] ?? null) as SqlValue);
    }
  }
  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  vals.push(referenceId);
  db.prepare(`UPDATE reference_items SET ${sets.join(', ')} WHERE reference_id = ?`).run(...vals);
}

/**
 * 削除。**メモも注釈も一緒に消える。**
 * 呼び出し側で確認を取ること（取り消せない）。
 */
export function deleteReference(db: Db, referenceId: string): void {
  db.exec('BEGIN');
  try {
    const row = db
      .prepare('SELECT paper_id FROM reference_items WHERE reference_id = ?')
      .get(referenceId) as { paper_id: string | null } | undefined;
    db.prepare('DELETE FROM reference_items WHERE reference_id = ?').run(referenceId);
    if (row?.paper_id) {
      db.prepare('UPDATE papers SET in_library = 0 WHERE paper_id = ?').run(row.paper_id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// --- 印（マーク） --------------------------------------------------------------

export function setStarred(db: Db, referenceId: string, starred: boolean): void {
  db.prepare("UPDATE reference_items SET starred = ?, updated_at = datetime('now') WHERE reference_id = ?").run(
    starred ? 1 : 0,
    referenceId,
  );
}

export function setReadStatus(db: Db, referenceId: string, status: ReadStatus): void {
  db.prepare(
    "UPDATE reference_items SET read_status = ?, updated_at = datetime('now') WHERE reference_id = ?",
  ).run(status, referenceId);
}

// --- タグ ---------------------------------------------------------------------

export function addTag(db: Db, projectId: string, referenceId: string, name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('タグ名が空');

  db.exec('BEGIN');
  try {
    let tag = db
      .prepare('SELECT tag_id FROM tags WHERE project_id = ? AND name = ?')
      .get(projectId, trimmed) as { tag_id: string } | undefined;

    if (!tag) {
      const id = randomUUID();
      db.prepare('INSERT INTO tags (tag_id, project_id, name) VALUES (?, ?, ?)').run(id, projectId, trimmed);
      tag = { tag_id: id };
    }

    db.prepare('INSERT OR IGNORE INTO reference_tags (reference_id, tag_id) VALUES (?, ?)').run(
      referenceId,
      tag.tag_id,
    );
    db.exec('COMMIT');
    return tag.tag_id;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function removeTag(db: Db, referenceId: string, name: string): void {
  db.prepare(
    `DELETE FROM reference_tags
     WHERE reference_id = ?
       AND tag_id IN (SELECT tag_id FROM tags WHERE name = ?)`,
  ).run(referenceId, name.trim());
}

/** プロジェクト内のタグと、それぞれの件数 */
export function listTags(db: Db, projectId: string): { name: string; count: number }[] {
  return db
    .prepare(
      `SELECT t.name, COUNT(rt.reference_id) AS count
       FROM tags t
       LEFT JOIN reference_tags rt ON rt.tag_id = t.tag_id
       WHERE t.project_id = ?
       GROUP BY t.tag_id
       ORDER BY count DESC, t.name`,
    )
    .all(projectId) as unknown as { name: string; count: number }[];
}

// --- メモ ---------------------------------------------------------------------

export function getNote(db: Db, referenceId: string): string {
  const r = db.prepare('SELECT body FROM notes WHERE reference_id = ?').get(referenceId) as
    | { body: string }
    | undefined;
  return r?.body ?? '';
}

export function saveNote(db: Db, referenceId: string, body: string): void {
  db.prepare(
    `INSERT INTO notes (reference_id, body, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT (reference_id) DO UPDATE SET body = excluded.body, updated_at = datetime('now')`,
  ).run(referenceId, body);
}

// --- 添付 ---------------------------------------------------------------------

export function findReferenceByDoi(db: Db, projectId: string, doi: string): string | undefined {
  const row = db
    .prepare('SELECT reference_id FROM reference_items WHERE project_id = ? AND doi = ?')
    .get(projectId, doi) as { reference_id: string } | undefined;
  return row?.reference_id;
}

export function findAttachmentByPath(db: Db, path: string): { attachment_id: string; reference_id: string } | undefined {
  return db
    .prepare('SELECT attachment_id, reference_id FROM attachments WHERE path = ?')
    .get(path) as { attachment_id: string; reference_id: string } | undefined;
}

export function addAttachment(db: Db, referenceId: string, path: string, kind = 'pdf'): string {
  const id = randomUUID();
  db.prepare('INSERT INTO attachments (attachment_id, reference_id, path, kind) VALUES (?, ?, ?, ?)').run(
    id,
    referenceId,
    path,
    kind,
  );
  return id;
}

export function listAttachments(db: Db, referenceId: string) {
  return db
    .prepare('SELECT attachment_id, path, kind, added_at FROM attachments WHERE reference_id = ? ORDER BY added_at')
    .all(referenceId) as unknown as {
    attachment_id: string;
    path: string;
    kind: string;
    added_at: string;
  }[];
}

export function removeAttachment(db: Db, attachmentId: string): void {
  // 注釈も一緒に消える（外部キーの ON DELETE CASCADE）。
  // **PDF の実体は消さない。** 利用者が置いたファイルを勝手に消さない（C-08）
  db.prepare('DELETE FROM attachments WHERE attachment_id = ?').run(attachmentId);
}

// --- 一覧 ---------------------------------------------------------------------

export function listReferences(db: Db, projectId: string, filter: LibraryFilter = {}): ReferenceRow[] {
  const where: string[] = ['r.project_id = ?'];
  const vals: SqlValue[] = [projectId];

  if (filter.query) {
    // メモの中身も検索対象にする。書いたことを思い出せないと意味がない
    where.push(
      `(r.title LIKE ? OR IFNULL(r.authors,'') LIKE ? OR IFNULL(r.venue,'') LIKE ?
        OR IFNULL((SELECT body FROM notes WHERE reference_id = r.reference_id), '') LIKE ?)`,
    );
    const q = `%${filter.query}%`;
    vals.push(q, q, q, q);
  }
  if (filter.starred) where.push('r.starred = 1');
  if (filter.readStatus) {
    where.push('r.read_status = ?');
    vals.push(filter.readStatus);
  }
  if (filter.tag) {
    where.push(
      `r.reference_id IN (
         SELECT rt.reference_id FROM reference_tags rt
         JOIN tags t ON t.tag_id = rt.tag_id
         WHERE t.project_id = ? AND t.name = ?)`,
    );
    vals.push(projectId, filter.tag);
  }

  const order =
    filter.sort === 'year'
      ? 'r.year DESC NULLS LAST, r.added_at DESC'
      : filter.sort === 'title'
        ? 'r.title COLLATE NOCASE'
        : 'r.added_at DESC';

  const rows = db
    .prepare(
      `SELECT r.reference_id, r.paper_id, r.title, r.authors, r.year, r.doi, r.url, r.venue,
              r.abstract, r.item_type, r.starred, r.read_status, r.bibtex_key, r.added_at, r.updated_at,
              (SELECT GROUP_CONCAT(t.name, '') FROM reference_tags rt
                 JOIN tags t ON t.tag_id = rt.tag_id WHERE rt.reference_id = r.reference_id) AS tag_csv,
              EXISTS (SELECT 1 FROM notes n WHERE n.reference_id = r.reference_id AND TRIM(n.body) <> '') AS has_note,
              (SELECT COUNT(*) FROM attachments a WHERE a.reference_id = r.reference_id) AS attachment_count
       FROM reference_items r
       WHERE ${where.join(' AND ')}
       ORDER BY ${order}`,
    )
    .all(...vals) as unknown as (Omit<ReferenceRow, 'tags'> & { tag_csv: string | null })[];

  return rows.map(({ tag_csv, ...r }) => ({
    ...r,
    tags: tag_csv ? tag_csv.split('').filter(Boolean) : [],
  }));
}

export function getReference(db: Db, referenceId: string): ReferenceRow | undefined {
  const r = db
    .prepare('SELECT project_id FROM reference_items WHERE reference_id = ?')
    .get(referenceId) as { project_id: string } | undefined;
  if (!r) return undefined;
  return listReferences(db, r.project_id).find((x) => x.reference_id === referenceId);
}

/** ライブラリの件数内訳。空表示と読み込み失敗を混ぜないため（C-07） */
export function libraryCounts(db: Db, projectId: string) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN starred = 1 THEN 1 ELSE 0 END) AS starred,
              SUM(CASE WHEN read_status = 'unread' THEN 1 ELSE 0 END) AS unread,
              SUM(CASE WHEN read_status = 'reading' THEN 1 ELSE 0 END) AS reading,
              SUM(CASE WHEN read_status = 'read' THEN 1 ELSE 0 END) AS read
       FROM reference_items WHERE project_id = ?`,
    )
    .get(projectId) as { total: number; starred: number | null; unread: number | null; reading: number | null; read: number | null };

  return {
    total: row.total,
    starred: row.starred ?? 0,
    unread: row.unread ?? 0,
    reading: row.reading ?? 0,
    read: row.read ?? 0,
  };
}
