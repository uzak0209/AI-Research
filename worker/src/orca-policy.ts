/**
 * ADR-0002 の分類と、ADR-0005 §2 の段ごとの Named Router を BFF がコードで持つ。
 *
 * 候補モデル（Allowed）・Default・受け皿（Fallback）は **Named Router 側の設定**に置く。
 * コードで `extra_body.models` を二重に持たない（ADR-0005 §2）。
 * ルーター設定の正本は `routers/*.yaml`。コンソールはその適用先。
 *
 * C2（許可リスト・初回同意）と C3（固定モデル・FB 無効）は endpoint 未実装。
 * モデル名をここで先に決めない。
 */
import type { Env } from './env';

export type OrcaKeySlot = 'cron' | 'interactive' | 'sensitive';

export type OrcaClassPolicy = {
  slot: OrcaKeySlot;
  /** 要求する宛先。Named Router 名またはモデル ID */
  model: string;
  /** extra_body.models。空なら gateway 側の受け皿に任せる */
  fallbacks: readonly string[];
  temperature: number;
  failOpen: false;
};

/** ルーターがコンソールに無い間は var で素のモデルへ逃がせる（ADR-0004: 手動設定を正にしない） */
export const DEFAULT_COLLECT_ROUTER = 'orcarouter/rs-collect';
export const DEFAULT_REVIEW_ROUTER = 'orcarouter/rs-review';

/**
 * 1 段目（収集）: `summary` から検索語を作るだけ。無料プール優先。
 * 回数が最も出る段なので、ここを $0 に寄せる（ADR-0005 §3）。
 */
export function collectPolicy(env: Env): OrcaClassPolicy {
  return {
    slot: 'cron',
    model: env.ORCA_ROUTER_COLLECT || DEFAULT_COLLECT_ROUTER,
    fallbacks: [],
    temperature: 0,
    failOpen: false,
  };
}

/**
 * 2 段目（レビュー）: 要約・論点整理。品質の下限を割らせない。
 * 受け皿は同格のみで、安価モデルへ落とさない（ADR-0005 §5）。その指定も Named Router 側。
 */
export function reviewPolicy(env: Env): OrcaClassPolicy {
  return {
    slot: 'interactive',
    model: env.ORCA_ROUTER_REVIEW || DEFAULT_REVIEW_ROUTER,
    fallbacks: [],
    temperature: 0,
    failOpen: false,
  };
}
