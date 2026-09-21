/**
 * ADR-0002 の System One（Jev）方針。TypeSafe ダッシュボードに依存しない。
 * 閾値はコードが決める。Jev は生成しない（noul / choice / score のみ）。
 */
export type JevClassPolicy = {
  /** ピン留め。latest だと閾値の意味が変わる */
  model: string;
  /** choice.confidence がこれ未満なら採用しない */
  minConfidence: number;
  /** noul がこれ未満なら採用しない */
  minNoul: number;
  failOpen: false;
};

export const JEV_POLICY = {
  C1: {
    model: 'jev-1.13.0',
    minConfidence: 0.7,
    minNoul: 0.7,
    failOpen: false,
  },
} as const satisfies Record<'C1', JevClassPolicy>;
