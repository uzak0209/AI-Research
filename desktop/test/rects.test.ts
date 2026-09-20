// 選択範囲の矩形をまとめる処理の検証。
// これが効かないと、重なった所だけマーカーが濃くなって縞になる。

import { describe, expect, it } from 'vitest';
import { mergeRects, type NormRect } from '../src/renderer/rects.js';

const line = (x: number, w: number, y = 0.1, h = 0.02): NormRect => ({ x, y, w, h });

describe('矩形をまとめる', () => {
  it('同じ行で重なる矩形をひとつにする', () => {
    // 文字の断片ごとに返ってきて、端が少し重なっている状態
    const out = mergeRects([line(0.1, 0.2), line(0.28, 0.2)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.x).toBeCloseTo(0.1, 6);
    expect(out[0]!.w).toBeCloseTo(0.38, 6); // 0.1 〜 0.48
  });

  it('完全に含まれる矩形は吸収される', () => {
    const out = mergeRects([line(0.1, 0.4), line(0.2, 0.1)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.w).toBeCloseTo(0.4, 6);
  });

  it('単語の隙間くらいなら繋ぐ', () => {
    // 0.004 の隙間は既定の許容 0.006 の内側
    const out = mergeRects([line(0.1, 0.1), line(0.204, 0.1)]);
    expect(out).toHaveLength(1);
  });

  it('明らかに離れていれば繋がない（段組みなど）', () => {
    const out = mergeRects([line(0.1, 0.1), line(0.6, 0.1)]);
    expect(out).toHaveLength(2);
  });

  it('行が違えば別のままにする', () => {
    const out = mergeRects([line(0.1, 0.3, 0.1), line(0.1, 0.3, 0.2)]);
    expect(out).toHaveLength(2);
    expect(out[0]!.y).toBeCloseTo(0.1, 6);
    expect(out[1]!.y).toBeCloseTo(0.2, 6);
  });

  it('少しだけ縦がずれていても同じ行として扱う', () => {
    // 同じ行でもフォントの違いで上下が数 % ずれる
    const out = mergeRects([line(0.1, 0.2, 0.1, 0.02), line(0.29, 0.2, 0.103, 0.018)]);
    expect(out).toHaveLength(1);
  });

  it('まとめた矩形は元の全体を覆う', () => {
    const src = [line(0.1, 0.2, 0.1, 0.02), line(0.28, 0.2, 0.103, 0.018)];
    const [m] = mergeRects(src);
    const top = Math.min(...src.map((r) => r.y));
    const bottom = Math.max(...src.map((r) => r.y + r.h));
    expect(m!.y).toBeCloseTo(top, 6);
    expect(m!.y + m!.h).toBeCloseTo(bottom, 6);
  });

  it('面積の無い矩形は落とす', () => {
    expect(mergeRects([{ x: 0.1, y: 0.1, w: 0, h: 0.02 }])).toEqual([]);
    expect(mergeRects([{ x: 0.1, y: 0.1, w: 0.2, h: 0 }])).toEqual([]);
  });

  it('空なら空', () => {
    expect(mergeRects([])).toEqual([]);
  });

  it('入力の順番に依らない', () => {
    const src = [line(0.5, 0.1, 0.2), line(0.1, 0.2, 0.1), line(0.28, 0.2, 0.1)];
    const a = mergeRects(src);
    const b = mergeRects([...src].reverse());
    expect(a).toEqual(b);
  });

  it('3 行にまたがる選択は 3 本の帯になる', () => {
    const out = mergeRects([
      line(0.3, 0.6, 0.10), // 1 行目は途中から
      line(0.31, 0.3, 0.10), // 断片
      line(0.1, 0.8, 0.14), // 2 行目
      line(0.1, 0.2, 0.18), // 3 行目は途中まで
    ]);
    expect(out).toHaveLength(3);
    expect(out.map((r) => Number(r.y.toFixed(2)))).toEqual([0.1, 0.14, 0.18]);
  });

  it('まとめた後は互いに重ならない（濃さが均一になる）', () => {
    const out = mergeRects([
      line(0.1, 0.2, 0.1),
      line(0.25, 0.2, 0.1),
      line(0.4, 0.2, 0.1),
      line(0.1, 0.3, 0.14),
    ]);
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]!;
        const b = out[j]!;
        const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        expect(overlapX > 0 && overlapY > 0).toBe(false);
      }
    }
  });
});
