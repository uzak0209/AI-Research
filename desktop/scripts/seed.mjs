#!/usr/bin/env node
/**
 * Electron のローカル SQLite に機能紹介用 seed を入れる。
 *
 *   node scripts/seed.mjs
 *   node scripts/seed.mjs --db /path/to/ai-research.db
 *
 * 既定パスは userData（macOS: ~/Library/Application Support/ai-research-desktop/ai-research.db）。
 * seed-demo だけを入れ直す。中身のある利用者プロジェクトは消さない。
 * 空の「新しいプロジェクト」だけは、一覧の先頭を seed にするため外す。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { applyDesktopSeed, isEmptyDefaultProject } from '../../seed/apply.mjs';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaSql = readFileSync(join(desktopRoot, 'src/shared/schema.sql'), 'utf8');
const EMBED_DIM = 384;

function defaultDbPath() {
  if (process.env.AI_RESEARCH_DB) return process.env.AI_RESEARCH_DB;
  const home = homedir();
  if (process.platform === 'darwin') {
    return join(home, 'Library/Application Support/ai-research-desktop/ai-research.db');
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'ai-research-desktop', 'ai-research.db');
  }
  return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'ai-research-desktop', 'ai-research.db');
}

function parseDbArg(argv) {
  const i = argv.indexOf('--db');
  if (i >= 0) {
    const p = argv[i + 1];
    if (!p) throw new Error('--db の後ろにパスが無い');
    return p;
  }
  return defaultDbPath();
}

function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { allowExtension: true });
  db.enableLoadExtension(true);
  const sqliteVec = createRequire(join(desktopRoot, 'package.json'))('sqlite-vec');
  sqliteVec.load(db);
  db.enableLoadExtension(false);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(schemaSql);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[${EMBED_DIM}])`);
  return db;
}

function dropEmptyDefault(db) {
  const projects = db.prepare('SELECT project_id, title, summary FROM projects ORDER BY created_at').all();
  let dropped = 0;
  for (const p of projects) {
    if (p.project_id === 'seed-demo') continue;
    if (!isEmptyDefaultProject(p)) continue;
    const papers = db.prepare('SELECT COUNT(*) AS n FROM papers WHERE project_id = ?').get(p.project_id);
    const refs = db.prepare('SELECT COUNT(*) AS n FROM reference_items WHERE project_id = ?').get(p.project_id);
    if (Number(papers.n) > 0 || Number(refs.n) > 0) continue;
    db.prepare('DELETE FROM projects WHERE project_id = ?').run(p.project_id);
    dropped += 1;
  }
  return dropped;
}

const dbPath = parseDbArg(process.argv.slice(2));
const created = !existsSync(dbPath);
const db = openDb(dbPath);
try {
  applyDesktopSeed(db);
  const dropped = dropEmptyDefault(db);
  const first = db.prepare('SELECT project_id, title FROM projects ORDER BY created_at').get();
  const refs = db.prepare('SELECT COUNT(*) AS n FROM reference_items WHERE project_id = ?').get('seed-demo');
  const ranked = db
    .prepare("SELECT COUNT(*) AS n FROM papers WHERE project_id = ? AND scored_at IS NOT NULL")
    .get('seed-demo');
  const unscored = db
    .prepare('SELECT COUNT(*) AS n FROM papers WHERE project_id = ? AND scored_at IS NULL')
    .get('seed-demo');

  console.log(created ? `DB を作った: ${dbPath}` : `DB に入れた: ${dbPath}`);
  console.log(`ライブラリ ${refs.n} 件 / 採点済み ${ranked.n} 件 / 未採点 ${unscored.n} 件`);
  if (dropped) console.log(`空の「新しいプロジェクト」を ${dropped} 件外した`);
  if (first?.project_id !== 'seed-demo') {
    console.log(
      `注意: 一覧の先頭は ${first?.title ?? '(なし)'}。UI は先頭プロジェクトだけを出すので、機能紹介には空の DB でやり直すか、この seed を先に入れてから起動する。`,
    );
  } else {
    console.log('先頭プロジェクトは seed-demo。Electron を起動し直すとライブラリと新着にデモが出る。');
  }
} finally {
  db.close();
}
