// 選択範囲の矩形を、行ごとにひとつながりへまとめる。
//
// なぜ要るか:
//   `Range.getClientRects()` は**文字の断片ごと**に矩形を返す。
//   pdf.js の文字層は 1 行が複数の span に分かれているため、
//   隣り合う矩形がわずかに重なることが多い。
//   そのまま 1 つずつ半透明で塗ると、**重なった所だけ色が濃くなって縞になる**。
//
//   行ごとにまとめてから塗れば、重なりが消えて濃さが均一になる。
//
// pdf.js を読み込まない純粋な処理なので、単体で試せるように分けてある。

export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MergeOptions {
  /**
   * 横に離れていてもつなぐ許容量（ページ幅に対する比）。
   * 単語の間の隙間を埋めて、1 行を 1 つの帯にするため
   */
  gap?: number;
  /** 同じ行とみなす縦の重なり具合（0〜1） */
  lineOverlap?: number;
}

const DEFAULTS: Required<MergeOptions> = { gap: 0.006, lineOverlap: 0.5 };

/** 縦にどれだけ重なっているか（小さい方の高さに対する比） */
function verticalOverlapRatio(a: NormRect, b: NormRect): number {
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  const overlap = bottom - top;
  if (overlap <= 0) return 0;
  return overlap / Math.min(a.h, b.h);
}

/**
 * 重なり・隣接をまとめる。行をまたぐ矩形は別々のまま返す。
 * 入力の順序に依存しない。
 */
export function mergeRects(rects: NormRect[], opts: MergeOptions = {}): NormRect[] {
  const { gap, lineOverlap } = { ...DEFAULTS, ...opts };

  // 面積の無い矩形は塗っても見えないので落とす
  const valid = rects.filter((r) => r.w > 0 && r.h > 0);
  if (valid.length === 0) return [];

  // 上から順に見て、縦が重なるものを同じ行に入れる
  const sorted = [...valid].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: NormRect[][] = [];

  for (const r of sorted) {
    const line = lines.find((l) => l.some((x) => verticalOverlapRatio(x, r) >= lineOverlap));
    if (line) line.push(r);
    else lines.push([r]);
  }

  const out: NormRect[] = [];

  for (const line of lines) {
    line.sort((a, b) => a.x - b.x);

    let cur = { ...line[0]! };
    for (const r of line.slice(1)) {
      // 重なっている、または隙間が許容内ならつなぐ
      if (r.x <= cur.x + cur.w + gap) {
        const right = Math.max(cur.x + cur.w, r.x + r.w);
        const top = Math.min(cur.y, r.y);
        const bottom = Math.max(cur.y + cur.h, r.y + r.h);
        cur = { x: cur.x, y: top, w: right - cur.x, h: bottom - top };
      } else {
        out.push(cur);
        cur = { ...r };
      }
    }
    out.push(cur);
  }

  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}
