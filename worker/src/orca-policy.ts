/**
 * ADR-0002 の分類を BFF がコードで持つ。Orca ダッシュボードの named router に依存しない。
 *
 * C2（許可リスト・初回同意）と C3（固定モデル・FB 無効・fail_open: false）は
 * endpoint 未実装。モデル名をここで先に決めない。
 */
export type OrcaKeySlot = 'cron' | 'interactive' | 'sensitive';

export type OrcaClassPolicy = {
  slot: OrcaKeySlot;
  /** 最初に試すモデル。C1 は auto 可だが、最安フラッシュ任せにはしない */
  model: string;
  /** extra_body.models。空なら fallback しない */
  fallbacks: readonly string[];
  temperature: number;
  failOpen: false;
};

export const ORCA_POLICY = {
  C1: {
    slot: 'interactive',
    model: 'openai/gpt-4o-mini',
    fallbacks: ['openai/gpt-4o-mini', 'google/gemini-2.5-flash', 'anthropic/claude-haiku-4.5'],
    temperature: 0,
    failOpen: false,
  },
} as const satisfies Record<'C1', OrcaClassPolicy>;
