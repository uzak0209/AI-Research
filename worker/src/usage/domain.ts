export type Classification = 'C1' | 'C2' | 'C3';

/** 設定が壊れていたら 0 = 全部止める（fail closed。NFR-04） */
export function dailyCallLimit(raw: string): number {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
