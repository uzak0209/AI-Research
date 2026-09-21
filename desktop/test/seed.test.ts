// 機能紹介 seed が、空画面で見たい状態（件数・順位・未採点の実数）を作ることを確かめる。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error catalog applicator is untyped JS
import { applyDesktopSeed, cloudSeedSql, isEmptyDefaultProject } from '../../seed/apply.mjs';
import { openDb, type Db } from '../src/shared/db.js';
import { countUnscored, listRanked } from '../src/shared/repo.js';
import { libraryCounts, listReferences, listTags } from '../src/shared/library.js';

let db: Db;

beforeEach(() => {
  db = openDb({ path: ':memory:' });
});

afterEach(() => db.close());

describe('desktop seed', () => {
  it('ライブラリの件数内訳とタグが、紹介で指差せる状態になる', () => {
    applyDesktopSeed(db);
    expect(libraryCounts(db, 'seed-demo')).toEqual({
      total: 6,
      starred: 2,
      unread: 3,
      reading: 1,
      read: 2,
    });
    const tags = listTags(db, 'seed-demo');
    expect(tags[0]).toMatchObject({ name: '手法', count: 4 });
    expect(tags.map((t) => t.name)).toEqual(['手法', '不確実性', '競合', '解釈', '転移学習']);
    const book = listReferences(db, 'seed-demo').find((r) => r.bibtex_key === 'hamilton2020');
    expect(book?.item_type).toBe('book');
    expect(book?.read_status).toBe('read');
  });

  it('新着は関連度順で、ライブラリ済と未採点は出さない（C-07）', () => {
    applyDesktopSeed(db);
    const ranked = listRanked(db, 'seed-demo');
    expect(ranked).toHaveLength(5);
    expect(ranked.every((p) => p.in_library === 0)).toBe(true);
    expect(countUnscored(db, 'seed-demo')).toBe(2);
    const scores = ranked.map((p) => p.relevance ?? 0);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(ranked[0]?.title).toMatch(/Chain-aware/);
    expect(ranked[0]?.nearest_chunk_text).toMatch(/graph neural|GNN|molecular/i);
    const lowest = ranked[ranked.length - 1];
    expect(lowest?.title).toMatch(/Robotic Manipulation/);
    expect(lowest?.nearest_chunk_text).toMatch(/active learning/);
  });

  it('空の自動生成プロジェクトと判定できる', () => {
    expect(isEmptyDefaultProject({ title: '新しいプロジェクト', summary: '' })).toBe(true);
    expect(isEmptyDefaultProject({ title: '新しいプロジェクト'.normalize('NFD'), summary: '  ' })).toBe(true);
    expect(isEmptyDefaultProject({ title: '低データ分子物性予測の GNN', summary: '' })).toBe(false);
  });
});

describe('cloud seed SQL', () => {
  it('ok / empty / failed / partial が揃い、利用者 id を消す文を含まない', () => {
    const sql = cloudSeedSql();
    expect(sql).toContain("'ok'");
    expect(sql).toContain("'empty'");
    expect(sql).toContain("'failed'");
    expect(sql).toContain("'partial'");
    expect(sql).toContain('google:seed-demo');
    expect(sql).toContain("user_id = 'seed-demo'");
    expect(sql).not.toMatch(/DELETE FROM users;$/m);
    expect(sql).toContain('OpenAlex 429');
  });
});
