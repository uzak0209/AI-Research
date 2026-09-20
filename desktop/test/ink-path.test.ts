// ペンの線を SVG パスにするところの検証。
// 座標は比で持つので、拡大率を変えても同じ形になることを固定する。

import { describe, expect, it } from 'vitest';
import { toPathData } from '../src/renderer/ink-path.js';

describe('ペンの線の描き方', () => {
  it('2 点なら直線になる', () => {
    const d = toPathData(
      [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      100,
      200,
    );
    expect(d).toBe('M 0.00 0.00 L 100.00 200.00');
  });

  it('3 点以上は曲線でつなぐ', () => {
    const d = toPathData(
      [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.5 },
        { x: 1, y: 0 },
      ],
      100,
      100,
    );
    expect(d).toContain('Q');
    expect(d.startsWith('M 0.00 0.00')).toBe(true);
    expect(d.endsWith('L 100.00 0.00')).toBe(true);
  });

  it('点が足りなければ空文字（描かない）', () => {
    expect(toPathData([], 100, 100)).toBe('');
    expect(toPathData([{ x: 0.5, y: 0.5 }], 100, 100)).toBe('');
  });

  it('拡大しても形は相似になる（比で持っているため）', () => {
    const pts = [
      { x: 0.1, y: 0.2 },
      { x: 0.4, y: 0.5 },
      { x: 0.7, y: 0.3 },
    ];
    const small = toPathData(pts, 100, 100);
    const large = toPathData(pts, 200, 200);
    const nums = (d: string) => d.match(/[\d.]+/g)!.map(Number);
    const s = nums(small);
    const l = nums(large);
    expect(l).toHaveLength(s.length);
    for (let i = 0; i < s.length; i++) expect(l[i]).toBeCloseTo(s[i]! * 2, 5);
  });
});
