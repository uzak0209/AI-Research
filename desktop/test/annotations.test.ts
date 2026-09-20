// PDF への書き込みの検証（FR-14 / C-08）。
// 重点は「PDF 本体を変えないこと」と「おかしな座標を静かに保存しないこと」。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/shared/db.js';
import { createProject } from '../src/shared/repo.js';
import { addAttachment, addReference } from '../src/shared/library.js';
import {
  addHighlight,
  addInk,
  countAnnotations,
  listAnnotations,
  removeAnnotation,
  setComment,
} from '../src/shared/annotations.js';

let db: Db;
const PROJ = 'p1';
let refId: string;
let atId: string;

beforeEach(() => {
  db = openDb({ path: ':memory:' });
  createProject(db, { project_id: PROJ, title: 't', summary: 's', embed_model: 'm' });
  refId = addReference(db, PROJ, { title: '論文', authors: 'Jane Smith', year: 2024 });
  atId = addAttachment(db, refId, 'C:/papers/a.pdf');
});

afterEach(() => db.close());

const rect = { x: 0.1, y: 0.2, w: 0.3, h: 0.02 };

describe('ハイライト', () => {
  it('引用文と色つきで保存できる', () => {
    const id = addHighlight(db, atId, { page: 2, rects: [rect], quote: '重要な主張', color: '#f5c518' });
    const [a] = listAnnotations(db, atId);
    expect(a!.annotation_id).toBe(id);
    expect(a!.kind).toBe('highlight');
    expect(a!.page).toBe(2);
    expect(JSON.parse(a!.rect_json!)).toEqual([rect]);
    expect(a!.quote).toBe('重要な主張');
    expect(a!.path_json).toBeNull();
  });

  it('範囲が空なら保存しない', () => {
    expect(() => addHighlight(db, atId, { page: 1, rects: [], quote: 'x', color: '#000' })).toThrow(
      /範囲が空/,
    );
  });

  it('比になっていない座標は弾く（ピクセル値の取り違え対策）', () => {
    expect(() =>
      addHighlight(db, atId, { page: 1, rects: [{ x: 320, y: 480, w: 100, h: 20 }], quote: 'x', color: '#000' }),
    ).toThrow(/比になっていない/);
  });
});

describe('ペンでの書き込み', () => {
  const points = [
    { x: 0.1, y: 0.1 },
    { x: 0.2, y: 0.15 },
    { x: 0.3, y: 0.12 },
  ];

  it('線を保存できる', () => {
    const id = addInk(db, atId, { page: 1, points, color: '#b3261e', strokeWidth: 0.003 });
    const [a] = listAnnotations(db, atId);
    expect(a!.annotation_id).toBe(id);
    expect(a!.kind).toBe('ink');
    expect(JSON.parse(a!.path_json!)).toEqual(points);
    expect(a!.stroke_width).toBeCloseTo(0.003, 6);
    expect(a!.rect_json).toBeNull();
  });

  it('点が 1 つだけの線は保存しない（押し間違い対策）', () => {
    expect(() =>
      addInk(db, atId, { page: 1, points: [{ x: 0.1, y: 0.1 }], color: '#000', strokeWidth: 0.003 }),
    ).toThrow(/短すぎる/);
  });

  it('比になっていない座標は弾く', () => {
    expect(() =>
      addInk(db, atId, {
        page: 1,
        points: [
          { x: 10, y: 20 },
          { x: 30, y: 40 },
        ],
        color: '#000',
        strokeWidth: 1,
      }),
    ).toThrow(/比になっていない/);
  });
});

describe('コメント', () => {
  it('ハイライトにもペンにも付けられる', () => {
    const h = addHighlight(db, atId, { page: 1, rects: [rect], quote: 'q', color: '#f5c518' });
    const i = addInk(db, atId, {
      page: 1,
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.2, y: 0.2 },
      ],
      color: '#000',
      strokeWidth: 0.003,
    });

    setComment(db, h, '自分の c08 と重なる');
    setComment(db, i, 'ここの図が分かりにくい');

    const all = listAnnotations(db, atId);
    expect(all.find((a) => a.annotation_id === h)!.comment).toBe('自分の c08 と重なる');
    expect(all.find((a) => a.annotation_id === i)!.comment).toBe('ここの図が分かりにくい');
  });

  it('空にすると「コメント無し」に戻る', () => {
    const h = addHighlight(db, atId, { page: 1, rects: [rect], quote: 'q', color: '#f5c518' });
    setComment(db, h, 'あとで消す');
    setComment(db, h, '   ');
    expect(listAnnotations(db, atId)[0]!.comment).toBeNull();
  });

  it('作成時にも付けられる', () => {
    addHighlight(db, atId, { page: 1, rects: [rect], quote: 'q', color: '#f5c518', comment: '最初から' });
    expect(listAnnotations(db, atId)[0]!.comment).toBe('最初から');
  });
});

describe('件数と削除', () => {
  it('種類ごとに数えられる', () => {
    addHighlight(db, atId, { page: 1, rects: [rect], quote: 'q', color: '#f5c518' });
    const i = addInk(db, atId, {
      page: 1,
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.2, y: 0.2 },
      ],
      color: '#000',
      strokeWidth: 0.003,
    });
    setComment(db, i, 'コメントあり');

    expect(countAnnotations(db, refId)).toEqual({ highlights: 1, inks: 1, comments: 1 });
  });

  it('書き込みが無ければ 0（null にしない）', () => {
    expect(countAnnotations(db, refId)).toEqual({ highlights: 0, inks: 0, comments: 0 });
  });

  it('消せる。他の書き込みは残る', () => {
    const a = addHighlight(db, atId, { page: 1, rects: [rect], quote: 'a', color: '#f5c518' });
    addHighlight(db, atId, { page: 1, rects: [rect], quote: 'b', color: '#f5c518' });
    removeAnnotation(db, a);
    const left = listAnnotations(db, atId);
    expect(left).toHaveLength(1);
    expect(left[0]!.quote).toBe('b');
  });

  it('添付を外すと書き込みも消える', () => {
    addHighlight(db, atId, { page: 1, rects: [rect], quote: 'q', color: '#f5c518' });
    db.prepare('DELETE FROM attachments WHERE attachment_id = ?').run(atId);
    expect(listAnnotations(db, atId)).toHaveLength(0);
  });

  it('ページ順・作成順に並ぶ', () => {
    addHighlight(db, atId, { page: 3, rects: [rect], quote: 'p3', color: '#000' });
    addHighlight(db, atId, { page: 1, rects: [rect], quote: 'p1', color: '#000' });
    expect(listAnnotations(db, atId).map((a) => a.quote)).toEqual(['p1', 'p3']);
  });
});
