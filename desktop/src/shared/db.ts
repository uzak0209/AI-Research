// ローカルストア。GUI と CLI が共有する唯一のコア（FR-11。二重管理しない）。
//
// SQLite は Node 組み込みの `node:sqlite` を使う。
// better-sqlite3 のようなネイティブ npm 依存を増やさないため（NFR-05）。
// Electron 44（Node 24.21）で動作することを実機で確認済み。
//
// ベクトル検索は sqlite-vec を拡張として読み込む。
// メタとベクトルを同一ファイル・同一トランザクションで扱えるので、
// 片方だけ更新される食い違いが起きない（ADR-0001）。

import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
// スキーマはバンドルに文字列として取り込む。
// 出力先のディレクトリ構成に依存させないため（ビルド後に schema.sql が隣に無い）
import schemaSql from './schema.sql?raw';

export type Db = DatabaseSync;

/** 埋め込みの次元。モデルを替えるときはここと projects.embed_model を揃える */
export const EMBED_DIM = 384; // bge-small-en-v1.5

export interface OpenOptions {
  /** DB ファイルのパス。':memory:' でテスト用 */
  path: string;
  /** sqlite-vec を読み込むか。読み込めない環境を黙って通さないため既定は true */
  vector?: boolean;
}

export class VectorExtensionError extends Error {
  constructor(cause: unknown) {
    super(
      `sqlite-vec を読み込めなかった: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'VectorExtensionError';
  }
}

/**
 * ローカル DB を開き、スキーマを適用して返す。
 * sqlite-vec が読めない場合は**黙って縮退しない**。呼び出し側に投げる（C-07）。
 */
export function openDb(opts: OpenOptions): Db {
  const { path, vector = true } = opts;

  const db = new DatabaseSync(path, { allowExtension: vector });

  if (vector) {
    try {
      db.enableLoadExtension(true);
      // 遅延 require。拡張が無い環境でも import 時点では落とさない
      const sqliteVec = requireSqliteVec();
      sqliteVec.load(db);
      db.enableLoadExtension(false);
    } catch (e) {
      db.close();
      throw new VectorExtensionError(e);
    }
  }

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(schemaSql);

  if (vector) {
    // chunks と 1 対 1 のベクトル。rowid を chunk_id に合わせる
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[${EMBED_DIM}])`,
    );
  }

  migrate(db);

  return db;
}

/**
 * 既にある DB に後から足した列を埋める。
 * `CREATE TABLE IF NOT EXISTS` は既存テーブルに列を足さないので、
 * これが無いと「開発中に作った DB だけ列が無い」という状態が静かに残る。
 */
function migrate(db: Db): void {
  const added: [table: string, column: string, ddl: string][] = [
    ['reference_items', 'venue', 'TEXT'],
    ['reference_items', 'abstract', 'TEXT'],
    ['reference_items', 'item_type', "TEXT NOT NULL DEFAULT 'article'"],
    ['reference_items', 'starred', 'INTEGER NOT NULL DEFAULT 0'],
    ['reference_items', 'read_status', "TEXT NOT NULL DEFAULT 'unread'"],
    ['reference_items', 'updated_at', 'TEXT'],
    // ペン書き込みとコメントのために後から足した列
    ['annotations', 'kind', "TEXT NOT NULL DEFAULT 'highlight'"],
    ['annotations', 'path_json', 'TEXT'],
    ['annotations', 'stroke_width', 'REAL'],
    ['annotations', 'updated_at', 'TEXT'],
    ['projects', 'root_path', 'TEXT'],
    ['papers', 'problem_excerpt', 'TEXT'],
  ];

  for (const [table, column, ddl] of added) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
    if (!cols.length) continue; // テーブル自体が無ければ schema.sql が作る
    if (cols.some((c) => c.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }

  rebuildNotesIfLegacy(db);
}

/**
 * `notes` を「1 文献 1 本」に作り直す。
 *
 * 旧版は note_id を主キーにしていたため 1 文献に複数のメモが入り得た。
 * `CREATE TABLE IF NOT EXISTS` は既存テーブルの形を変えないので、
 * これが無いと**既存の DB でだけ** saveNote の ON CONFLICT(reference_id) が失敗する。
 */
function rebuildNotesIfLegacy(db: Db): void {
  const cols = db.prepare('PRAGMA table_info(notes)').all() as unknown as {
    name: string;
    pk: number;
  }[];
  if (!cols.length) return;

  const pk = cols.filter((c) => c.pk).map((c) => c.name);
  if (pk.length === 1 && pk[0] === 'reference_id') return; // 既に新しい形

  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE notes_new (
        reference_id TEXT PRIMARY KEY REFERENCES reference_items(reference_id) ON DELETE CASCADE,
        body         TEXT NOT NULL DEFAULT '',
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    // 1 文献に複数あった場合は新しい方を残す。黙って先頭を採らない
    db.exec(`
      INSERT INTO notes_new (reference_id, body, updated_at)
      SELECT reference_id, body, updated_at FROM notes
      WHERE rowid IN (
        SELECT MAX(rowid) FROM notes GROUP BY reference_id
      )
    `);
    db.exec('DROP TABLE notes');
    db.exec('ALTER TABLE notes_new RENAME TO notes');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

type SqliteVec = { load: (db: unknown) => void; getLoadablePath: () => string };

function requireSqliteVec(): SqliteVec {
  // ESM から CJS のネイティブ配布物を読む
  const req = createRequire(import.meta.url);
  return req('sqlite-vec') as SqliteVec;
}

/** Float32Array をそのまま sqlite-vec に渡せる形にする */
export function toVectorBlob(v: Float32Array | number[]): Uint8Array {
  const f = v instanceof Float32Array ? v : Float32Array.from(v);
  if (f.length !== EMBED_DIM) {
    // 次元が違うベクトルを入れると検索が静かに壊れる。ここで落とす
    throw new Error(`埋め込みの次元が違う: ${f.length}（期待 ${EMBED_DIM}）`);
  }
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
}

/** 正規化済みベクトル同士の内積 = cos */
export function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
  return s;
}
