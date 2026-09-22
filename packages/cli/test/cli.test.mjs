// CLI が GUI（desktop）と同じローカルストアを add / search / list できることの検証（FR-11）。
// 実行には packages/core の `npm run build`（dist/）が要る。

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { openDb, createProject } from '@ai-research/core/node';

const BIN = fileURLToPath(new URL('../bin/ai-research.mjs', import.meta.url));

function run(args, dbPath, opts = {}) {
  return execFileSync('node', [BIN, ...args], {
    env: { ...process.env, AI_RESEARCH_DB_PATH: dbPath },
    encoding: 'utf8',
    ...opts,
  });
}

describe('ai-research CLI（FR-11）', () => {
  let dir;
  let dbPath;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-research-cli-test-'));
    dbPath = join(dir, 'ai-research.db');
    const db = openDb({ path: dbPath, vector: false });
    createProject(db, { title: 'Test Project', summary: '', embed_model: 'm', project_id: 'proj-1' });
    db.close();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('project list は既存プロジェクトを出す', () => {
    const out = run(['project', 'list'], dbPath);
    assert.match(out, /proj-1\tTest Project/);
  });

  it('lib add はライブラリに追加し、GUI と同じテーブルに残る（同一ストア）', () => {
    const out = run(['lib', 'add', '--title', 'Attention Is All You Need', '--authors', 'Vaswani', '--year', '2017'], dbPath);
    assert.match(out, /vaswani2017/);

    const db = openDb({ path: dbPath, vector: false });
    const rows = db.prepare('SELECT title FROM reference_items').all();
    db.close();
    assert.deepEqual(rows.map((r) => r.title), ['Attention Is All You Need']);
  });

  it('lib search はタイトル部分一致で検索できる', () => {
    const out = run(['lib', 'search', 'attention', '--json'], dbPath);
    const rows = JSON.parse(out);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].bibtex_key, 'vaswani2017');
  });

  it('lib search は一致しなければ空で終える（存在しないふりをしない）', () => {
    const out = run(['lib', 'search', 'nonexistent-xyz'], dbPath);
    assert.match(out, /見つからない/);
  });

  it('lib list は一覧を出す', () => {
    const out = run(['lib', 'list', '--json'], dbPath);
    const rows = JSON.parse(out);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'Attention Is All You Need');
  });

  it('--title が無い lib add は失敗して終了コード 1', () => {
    assert.throws(() => run(['lib', 'add', '--authors', 'x'], dbPath));
  });

  it('プロジェクトが複数あるとき --project 無しでは断定せず一覧を示して失敗する', () => {
    const db = openDb({ path: dbPath, vector: false });
    createProject(db, { title: 'Second', summary: '', embed_model: 'm', project_id: 'proj-2' });
    db.close();

    assert.throws(
      () => run(['lib', 'list'], dbPath, { stdio: ['ignore', 'pipe', 'pipe'] }),
      /プロジェクトが複数ある/,
    );
  });
});
