#!/usr/bin/env node
// CLI（FR-11 / 成功条件 8 / ADR-0003）。
//
// GUI（desktop）と同じローカル SQLite を、@ai-research/core の共有コア経由で
// 読み書きする第二の操作面。Electron 未起動でも動く（NFR-02）。
// 初版は ADR-0003 の決定どおり「追加・検索・一覧」だけを持つ。
//
// ベクトル拡張（sqlite-vec）は読み込まない。参考文献ライブラリの表
// （reference_items / tags / notes）は埋め込みを使わないため不要（C-07 に反しない縮退）。

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  openDb,
  getProject,
  listProjects,
  addReference,
  listReferences,
  getReference,
} from '@ai-research/core/node';

// デスクトップの実際の保存先フォルダ名。
// desktop/src/main/index.ts の dbPath() は app.getPath('userData') を
// app.setName('AI-Research') より前に呼んでいるため、実際に使われる名前は
// package.json の "name"（ai-research-desktop）のままになる（Electron は
// userData パスを最初のアクセス時に確定し、後からの setName では動かさない）。
// 確実ではないので --db / AI_RESEARCH_DB_PATH で必ず上書きできるようにしてある。
const DESKTOP_APP_DIR_NAME = 'ai-research-desktop';
const DB_FILE_NAME = 'ai-research.db';

function defaultUserDataDir() {
  const home = homedir();
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', DESKTOP_APP_DIR_NAME);
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    return join(appData, DESKTOP_APP_DIR_NAME);
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(home, '.config');
  return join(xdgConfig, DESKTOP_APP_DIR_NAME);
}

function defaultDbPath() {
  return process.env.AI_RESEARCH_DB_PATH || join(defaultUserDataDir(), DB_FILE_NAME);
}

class CliError extends Error {}

// 超簡易 argv パーサ。`--flag value` と `--flag`（真偽）だけ扱う。
// コマンドが多くないので、依存を増やしてまで CLI フレームワークを入れない（NFR-05）
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function openStore(flags) {
  const path = typeof flags.db === 'string' ? flags.db : defaultDbPath();
  mkdirSync(join(path, '..'), { recursive: true });
  const db = openDb({ path, vector: false });
  return { db, path };
}

/** --project が無ければプロジェクトが 1 つのときだけそれを使う。断定しない（C-07） */
function resolveProjectId(db, flags) {
  if (typeof flags.project === 'string') {
    const project = getProject(db, flags.project);
    if (!project) throw new CliError(`プロジェクトが見つからない: ${flags.project}`);
    return project.project_id;
  }
  const projects = listProjects(db);
  if (projects.length === 1) return projects[0].project_id;
  if (projects.length === 0) {
    throw new CliError('プロジェクトが無い。先に GUI で作成してください');
  }
  throw new CliError(
    'プロジェクトが複数ある。--project <id> で指定してください\n' +
      projects.map((p) => `  ${p.project_id}\t${p.title}`).join('\n'),
  );
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printReferenceRow(r) {
  const year = r.year ?? '----';
  const authors = r.authors ?? '(著者不明)';
  const tags = r.tags.length ? ` [${r.tags.join(', ')}]` : '';
  console.log(`${r.bibtex_key}\t${year}\t${authors}\t${r.title}${tags}`);
}

function cmdProjectList(flags) {
  const { db } = openStore(flags);
  try {
    const projects = listProjects(db);
    if (flags.json) return printJson(projects);
    if (projects.length === 0) {
      console.log('プロジェクトが無い');
      return;
    }
    for (const p of projects) console.log(`${p.project_id}\t${p.title}`);
  } finally {
    db.close();
  }
}

function cmdLibAdd(flags) {
  if (typeof flags.title !== 'string' || !flags.title.trim()) {
    throw new CliError('--title は必須');
  }
  const { db } = openStore(flags);
  try {
    const projectId = resolveProjectId(db, flags);
    const year = typeof flags.year === 'string' ? Number(flags.year) : null;
    if (flags.year !== undefined && !Number.isInteger(year)) {
      throw new CliError(`--year が数値ではない: ${flags.year}`);
    }
    const referenceId = addReference(db, projectId, {
      title: flags.title,
      authors: typeof flags.authors === 'string' ? flags.authors : null,
      year,
      doi: typeof flags.doi === 'string' ? flags.doi : null,
      url: typeof flags.url === 'string' ? flags.url : null,
      venue: typeof flags.venue === 'string' ? flags.venue : null,
      abstract: typeof flags.abstract === 'string' ? flags.abstract : null,
      item_type: typeof flags.type === 'string' ? flags.type : undefined,
    });
    const row = getReference(db, referenceId);
    if (flags.json) return printJson(row);
    console.log(`追加した: ${row.bibtex_key}\t${row.title}`);
  } finally {
    db.close();
  }
}

function cmdLibList(flags) {
  const { db } = openStore(flags);
  try {
    const projectId = resolveProjectId(db, flags);
    const rows = listReferences(db, projectId, {
      tag: typeof flags.tag === 'string' ? flags.tag : undefined,
      starred: flags.starred === true,
      readStatus: typeof flags.status === 'string' ? flags.status : undefined,
      sort: typeof flags.sort === 'string' ? flags.sort : undefined,
    });
    if (flags.json) return printJson(rows);
    if (rows.length === 0) {
      console.log('ライブラリが空');
      return;
    }
    for (const r of rows) printReferenceRow(r);
  } finally {
    db.close();
  }
}

function cmdLibSearch(flags, positional) {
  const query = positional.join(' ').trim();
  if (!query) throw new CliError('検索語が無い: ai-research lib search <query>');
  const { db } = openStore(flags);
  try {
    const projectId = resolveProjectId(db, flags);
    const rows = listReferences(db, projectId, { query });
    if (flags.json) return printJson(rows);
    if (rows.length === 0) {
      console.log('見つからない');
      return;
    }
    for (const r of rows) printReferenceRow(r);
  } finally {
    db.close();
  }
}

const USAGE = `ai-research <command> [options]

GUI（desktop）と同じローカルライブラリを操作する CLI（FR-11）。

  project list                          プロジェクト一覧
  lib add --title <t> [--project <id>]  参考文献を追加
          [--authors] [--year] [--doi] [--url] [--venue] [--abstract] [--type]
  lib search <query> [--project <id>]   タイトル・著者・掲載誌・メモを検索
  lib list [--project <id>]             一覧
          [--tag <t>] [--starred] [--status unread|reading|read] [--sort added|year|title]

共通オプション:
  --db <path>   DB ファイルを明示指定（既定は GUI と同じ推定パス）
  --json        JSON で出力
`;

function main() {
  const [command, sub, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);

  if (!command || flags.help || command === '--help' || command === 'help') {
    console.log(USAGE);
    return;
  }

  if (command === 'project' && sub === 'list') return cmdProjectList(flags);
  if (command === 'lib' && sub === 'add') return cmdLibAdd(flags);
  if (command === 'lib' && sub === 'list') return cmdLibList(flags);
  if (command === 'lib' && sub === 'search') return cmdLibSearch(flags, positional);

  throw new CliError(`不明なコマンド: ${[command, sub].filter(Boolean).join(' ')}\n\n${USAGE}`);
}

try {
  main();
} catch (e) {
  if (e instanceof CliError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
