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

  return db;
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
