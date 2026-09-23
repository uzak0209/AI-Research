// 参考文献ライブラリの検証（FR-05 / FR-14 / C-08）。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/shared/db.js';
import { createProject, listUnscored, upsertPapers } from '../src/shared/repo.js';
import {
  addAttachment,
  addReference,
  addTag,
  deleteReference,
  getNote,
  getReference,
  libraryCounts,
  listAttachments,
  listReferences,
  listTags,
  removeAttachment,
  removeTag,
  saveNote,
  setReadStatus,
  setStarred,
  updateReference,
} from '../src/shared/library.js';

let db: Db;
const PROJ = 'p1';

beforeEach(() => {
  db = openDb({ path: ':memory:' });
  createProject(db, { project_id: PROJ, title: 't', summary: 's', embed_model: 'm' });
});

afterEach(() => db.close());

const sample = (over = {}) => ({
  title: 'Graph neural networks for molecules',
  authors: 'Jane Smith; John Doe',
  year: 2024,
  venue: 'JCIM',
  ...over,
});

describe('保存と編集', () => {
  it('自分で入力した文献を保存できる', () => {
    const id = addReference(db, PROJ, sample());
    const r = getReference(db, id)!;
    expect(r.title).toMatch(/Graph neural networks/);
    expect(r.bibtex_key).toBe('smith2024');
    expect(r.read_status).toBe('unread');
    expect(r.starred).toBe(0);
  });

  it('あとから編集できる', () => {
    const id = addReference(db, PROJ, sample());
    updateReference(db, id, { title: '修正後', year: 2025, venue: null });
    const r = getReference(db, id)!;
    expect(r.title).toBe('修正後');
    expect(r.year).toBe(2025);
    expect(r.venue).toBeNull();
  });

  it('空の patch では何も壊さない', () => {
    const id = addReference(db, PROJ, sample());
    updateReference(db, id, {});
    expect(getReference(db, id)!.title).toMatch(/Graph neural/);
  });

  it('更新・削除は引用ファイル再書き出し（FR-12）用に project_id を返す', () => {
    const id = addReference(db, PROJ, sample());
    expect(updateReference(db, id, { year: 2025 })).toBe(PROJ);
    expect(updateReference(db, id, {})).toBeNull();
    expect(deleteReference(db, id)).toBe(PROJ);
    expect(deleteReference(db, id)).toBeNull();
  });

  it('削除するとメモも消える', () => {
    const id = addReference(db, PROJ, sample());
    saveNote(db, id, 'あとで読む');
    deleteReference(db, id);
    expect(getReference(db, id)).toBeUndefined();
    expect(getNote(db, id)).toBe('');
  });

  it('候補から入れた文献を削除すると論文側の印も戻る', () => {
    upsertPapers(db, PROJ, [{ external_id: 'a', source: 's', title: 'A', abstract: null }]);
    const [p] = listUnscored(db, PROJ);
    const id = addReference(db, PROJ, sample({ paper_id: p!.paper_id }));

    const before = db.prepare('SELECT in_library FROM papers WHERE paper_id = ?').get(p!.paper_id) as { in_library: number };
    expect(before.in_library).toBe(1);

    deleteReference(db, id);
    const after = db.prepare('SELECT in_library FROM papers WHERE paper_id = ?').get(p!.paper_id) as { in_library: number };
    expect(after.in_library).toBe(0);
  });
});

describe('印（マーク）', () => {
  it('星と読了状態を付け外しできる', () => {
    const id = addReference(db, PROJ, sample());
    setStarred(db, id, true);
    setReadStatus(db, id, 'reading');
    const r = getReference(db, id)!;
    expect(r.starred).toBe(1);
    expect(r.read_status).toBe('reading');

    setStarred(db, id, false);
    expect(getReference(db, id)!.starred).toBe(0);
  });

  it('読了状態は決められた値しか入らない', () => {
    const id = addReference(db, PROJ, sample());
    expect(() => setReadStatus(db, id, 'まだ' as never)).toThrow();
  });

  it('件数の内訳が出る', () => {
    const a = addReference(db, PROJ, sample());
    const b = addReference(db, PROJ, sample({ authors: 'Ann Brown', doi: '10.1/b' }));
    setStarred(db, a, true);
    setReadStatus(db, b, 'read');

    expect(libraryCounts(db, PROJ)).toEqual({ total: 2, starred: 1, unread: 1, reading: 0, read: 1 });
  });

  it('空のライブラリでも 0 が返る（null にしない）', () => {
    expect(libraryCounts(db, PROJ)).toEqual({ total: 0, starred: 0, unread: 0, reading: 0, read: 0 });
  });
});

describe('タグ', () => {
  it('付けて外せる。同じ名前は 1 つにまとまる', () => {
    const a = addReference(db, PROJ, sample());
    const b = addReference(db, PROJ, sample({ authors: 'Ann Brown', doi: '10.1/b' }));

    addTag(db, PROJ, a, '手法');
    addTag(db, PROJ, b, '手法');
    addTag(db, PROJ, a, '再現したい');

    expect(listTags(db, PROJ)).toEqual([
      { name: '手法', count: 2 },
      { name: '再現したい', count: 1 },
    ]);

    removeTag(db, a, '手法');
    expect(listTags(db, PROJ).find((t) => t.name === '手法')!.count).toBe(1);
  });

  it('同じタグを二度付けても重複しない', () => {
    const a = addReference(db, PROJ, sample());
    addTag(db, PROJ, a, '手法');
    addTag(db, PROJ, a, '手法');
    expect(getReference(db, a)!.tags).toEqual(['手法']);
  });

  it('空のタグ名は弾く', () => {
    const a = addReference(db, PROJ, sample());
    expect(() => addTag(db, PROJ, a, '   ')).toThrow(/タグ名が空/);
  });
});

describe('メモ', () => {
  it('書いて読み出せる。上書きできる', () => {
    const id = addReference(db, PROJ, sample());
    expect(getNote(db, id)).toBe('');
    saveNote(db, id, '一段落目の主張が自分のc08と重なる');
    expect(getNote(db, id)).toMatch(/c08/);
    saveNote(db, id, '書き直した');
    expect(getNote(db, id)).toBe('書き直した');
  });

  it('メモの有無が一覧に出る', () => {
    const id = addReference(db, PROJ, sample());
    expect(listReferences(db, PROJ)[0]!.has_note).toBe(0);
    saveNote(db, id, 'あり');
    expect(listReferences(db, PROJ)[0]!.has_note).toBe(1);
  });

  it('空白だけのメモは「ある」ことにしない', () => {
    const id = addReference(db, PROJ, sample());
    saveNote(db, id, '   ');
    expect(listReferences(db, PROJ)[0]!.has_note).toBe(0);
  });
});

describe('添付（C-08）', () => {
  it('添付を足して一覧できる', () => {
    const id = addReference(db, PROJ, sample());
    addAttachment(db, id, 'C:/papers/a.pdf');
    const list = listAttachments(db, id);
    expect(list).toHaveLength(1);
    expect(list[0]!.path).toBe('C:/papers/a.pdf');
    expect(listReferences(db, PROJ)[0]!.attachment_count).toBe(1);
  });

  it('添付を外しても PDF の実体は消さない（DB の行だけ消す）', () => {
    const id = addReference(db, PROJ, sample());
    const at = addAttachment(db, id, 'C:/papers/a.pdf');
    removeAttachment(db, at);
    expect(listAttachments(db, id)).toHaveLength(0);
    // 実体のパスはこちらの管理外。消す処理を持たないことをここで固定する
  });
});

describe('検索と絞り込み', () => {
  beforeEach(() => {
    const a = addReference(db, PROJ, sample({ title: 'GNN transfer learning', authors: 'Jane Smith', year: 2024 }));
    const b = addReference(db, PROJ, sample({ title: 'Machine translation', authors: 'Ann Brown', year: 2020, doi: '10.1/b' }));
    setStarred(db, a, true);
    setReadStatus(db, b, 'read');
    addTag(db, PROJ, a, '手法');
    saveNote(db, b, '翻訳の評価指標が参考になる');
  });

  it('タイトルと著者で絞れる', () => {
    expect(listReferences(db, PROJ, { query: 'transfer' })).toHaveLength(1);
    expect(listReferences(db, PROJ, { query: 'Brown' })).toHaveLength(1);
  });

  it('メモの中身でも見つかる', () => {
    const hit = listReferences(db, PROJ, { query: '評価指標' });
    expect(hit).toHaveLength(1);
    expect(hit[0]!.title).toBe('Machine translation');
  });

  it('星・読了・タグで絞れる', () => {
    expect(listReferences(db, PROJ, { starred: true })).toHaveLength(1);
    expect(listReferences(db, PROJ, { readStatus: 'read' })).toHaveLength(1);
    expect(listReferences(db, PROJ, { tag: '手法' })).toHaveLength(1);
  });

  it('並び替えられる', () => {
    expect(listReferences(db, PROJ, { sort: 'year' })[0]!.year).toBe(2024);
    expect(listReferences(db, PROJ, { sort: 'title' })[0]!.title).toBe('GNN transfer learning');
  });

  it('該当なしは空配列。エラーにしない', () => {
    expect(listReferences(db, PROJ, { query: 'そんな語は無い' })).toEqual([]);
  });
});
