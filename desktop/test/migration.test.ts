// 既にある DB を壊さずに移行できるかの検証。
//
// `CREATE TABLE IF NOT EXISTS` は既存テーブルの形を変えないため、
// **開発中に作った DB でだけ壊れる**という状態が起きやすい。ここで固定する。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/shared/db.js';
import { createProject } from '../src/shared/repo.js';
import { addReference, getNote, saveNote } from '../src/shared/library.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'airesearch-mig-'));
  path = join(dir, 'legacy.db');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 旧版のスキーマ（列が少なく、notes が note_id 主キー）を作る */
function makeLegacyDb() {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE projects (
      project_id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
      embed_model TEXT NOT NULL, last_run_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE reference_items (
      reference_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, paper_id TEXT,
      title TEXT NOT NULL, authors TEXT, year INTEGER, doi TEXT, url TEXT,
      bibtex_key TEXT NOT NULL, added_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE notes (
      note_id TEXT PRIMARY KEY, reference_id TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare('INSERT INTO projects (project_id, title, embed_model) VALUES (?, ?, ?)').run('p1', '旧', 'm');
  db.prepare(
    'INSERT INTO reference_items (reference_id, project_id, title, bibtex_key) VALUES (?, ?, ?, ?)',
  ).run('r1', 'p1', '既存の文献', 'old2020');
  return db;
}

describe('既存 DB の移行', () => {
  it('足りない列が追加され、既存の行は残る', () => {
    makeLegacyDb().close();

    const db = openDb({ path });
    const cols = (db.prepare('PRAGMA table_info(reference_items)').all() as unknown as { name: string }[]).map(
      (c) => c.name,
    );
    for (const c of ['venue', 'abstract', 'item_type', 'starred', 'read_status', 'updated_at']) {
      expect(cols).toContain(c);
    }
    const projCols = (db.prepare('PRAGMA table_info(projects)').all() as unknown as { name: string }[]).map(
      (c) => c.name,
    );
    expect(projCols).toContain('root_path');

    const r = db.prepare('SELECT title, starred, read_status FROM reference_items WHERE reference_id = ?').get('r1') as {
      title: string;
      starred: number;
      read_status: string;
    };
    expect(r.title).toBe('既存の文献');
    expect(r.starred).toBe(0); // 既定値が入る
    expect(r.read_status).toBe('unread');
    db.close();
  });

  it('notes が「1 文献 1 本」に作り直され、メモが保存できるようになる', () => {
    const legacy = makeLegacyDb();
    legacy
      .prepare('INSERT INTO notes (note_id, reference_id, body, updated_at) VALUES (?, ?, ?, ?)')
      .run('n1', 'r1', '古いメモ', '2026-01-01 00:00:00');
    legacy.close();

    const db = openDb({ path });

    const pk = (db.prepare('PRAGMA table_info(notes)').all() as unknown as { name: string; pk: number }[])
      .filter((c) => c.pk)
      .map((c) => c.name);
    expect(pk).toEqual(['reference_id']);

    // 既存のメモが残っている
    expect(getNote(db, 'r1')).toBe('古いメモ');

    // 旧版では失敗していた上書きが通る
    saveNote(db, 'r1', '書き直した');
    expect(getNote(db, 'r1')).toBe('書き直した');
    db.close();
  });

  it('1 文献に複数メモがあった場合は新しい方を残す', () => {
    const legacy = makeLegacyDb();
    const ins = legacy.prepare('INSERT INTO notes (note_id, reference_id, body, updated_at) VALUES (?, ?, ?, ?)');
    ins.run('n1', 'r1', '古い', '2026-01-01 00:00:00');
    ins.run('n2', 'r1', '新しい', '2026-06-01 00:00:00');
    legacy.close();

    const db = openDb({ path });
    expect(getNote(db, 'r1')).toBe('新しい');
    db.close();
  });

  it('移行後にライブラリの操作が通る', () => {
    makeLegacyDb().close();

    const db = openDb({ path });
    const id = addReference(db, 'p1', { title: '新しく足した', authors: 'Jane Smith', year: 2026 });
    saveNote(db, id, 'メモ');
    expect(getNote(db, id)).toBe('メモ');
    db.close();
  });

  it('二度開いても壊れない（移行は冪等）', () => {
    makeLegacyDb().close();
    openDb({ path }).close();
    const db = openDb({ path });
    expect(createProject(db, { project_id: 'p2', title: 't', summary: 's', embed_model: 'm' }).project_id).toBe('p2');
    expect(getNote(db, 'r1')).toBe('');
    db.close();
  });
});
