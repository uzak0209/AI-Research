// ペンの線を SVG のパスにする。
// pdf.js を読み込まない純粋な処理なので、単体で試せるように分けてある。

export interface NormPoint {
  x: number;
  y: number;
}

/**
 * 点の列を滑らかな SVG パスにする（中点を通る二次ベジエ）。
 * 入力はページ幅・高さに対する比なので、w/h を変えれば相似に拡大される。
 */
export function toPathData(pts: NormPoint[], w: number, h: number): string {
  if (pts.length < 2) return '';
  const px = (p: NormPoint) => [p.x * w, p.y * h] as const;

  const [x0, y0] = px(pts[0]!);
  let d = `M ${x0.toFixed(2)} ${y0.toFixed(2)}`;

  for (let i = 1; i < pts.length - 1; i++) {
    const [cx, cy] = px(pts[i]!);
    const [nx, ny] = px(pts[i + 1]!);
    d += ` Q ${cx.toFixed(2)} ${cy.toFixed(2)} ${((cx + nx) / 2).toFixed(2)} ${((cy + ny) / 2).toFixed(2)}`;
  }

  const [lx, ly] = px(pts.at(-1)!);
  d += ` L ${lx.toFixed(2)} ${ly.toFixed(2)}`;
  return d;
}
