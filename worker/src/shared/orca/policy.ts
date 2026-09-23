/**
 * ADR-0002 の分類と、ADR-0005 §2 の段ごとの Named Router を BFF がコードで持つ。
 *
 * 候補モデル（Allowed）・Default・戦略は **Named Router 側**（`routers/*.yaml`）が正本。
 * コンソールにルーターが無いと `orcarouter/{name}` は 502 になる。
 * extra_body の先頭に同じ名前を置き、解決できないエントリは Orca が黙って飛ばす
 * （コンソール未整備時の逃げ。var で素のモデルへ逃がすのと同趣旨）。
 *
 * 書誌補完（C1 interactive）は Named Router を使わない。安価モデル直指定（ADR-0002）。
 * C2（許可リスト・初回同意）と C3（固定モデル・FB 無効）は endpoint 未実装。
 */
import type { Env } from '../../env';

export type OrcaKeySlot = 'cron' | 'interactive' | 'sensitive';

export type OrcaClassPolicy = {
  slot: OrcaKeySlot;
  /** 要求する宛先。Named Router 名またはモデル ID */
  model: string;
  /** extra_body.models。空なら gateway 側の受け皿に任せる */
  fallbacks: readonly string[];
  temperature: number;
  failOpen: false;
  /** 完了トークン上限。トークン/論文を抑える。未指定なら上流の既定 */
  maxTokens?: number;
};

/** extra_body.models は最大 5（Orca が超えた分を黙って切る） */
const MAX_FALLBACKS = 5;

const COLLECT_CHAIN = ['openai/gpt-4o-mini', 'google/gemini-2.5-flash'] as const;
const REVIEW_CHAIN = ['google/gemini-2.5-flash', 'anthropic/claude-haiku-4.5'] as const;

export const COLLECT_MAX_TOKENS = 200;
export const REVIEW_MAX_TOKENS = 700;
export const BIBLIOGRAPHY_MAX_TOKENS = 600;
export const KEYWORDS_MAX_TOKENS = 600;
/**
 * トレンドは本文 2〜6 文＋次テーマ 5 件を 1 回で返す。
 * 日本語は 1 文字 1 トークン前後で、700 だと途中で切れて JSON が壊れる。
 */
export const TREND_MAX_TOKENS = 1600;

/**
 * 書誌補完（C1）／設定画面のキーワード推測（C1）。どちらも Named Router に載せない。
 * 1 段目専用の `rs-collect`（Queue consumer 専用。§2）を HTTP ハンドラから叩かないための直指定
 * （#100）。安価モデル直指定は書誌補完と同じ形（ADR-0002）。
 */
export const ORCA_POLICY = {
  C1: {
    slot: 'interactive',
    model: 'openai/gpt-4o-mini',
    fallbacks: ['openai/gpt-4o-mini', 'google/gemini-2.5-flash', 'anthropic/claude-haiku-4.5'],
    temperature: 0,
    failOpen: false,
    maxTokens: BIBLIOGRAPHY_MAX_TOKENS,
  },
  KEYWORDS: {
    slot: 'interactive',
    model: 'openai/gpt-4o-mini',
    fallbacks: ['openai/gpt-4o-mini', 'google/gemini-2.5-flash', 'anthropic/claude-haiku-4.5'],
    temperature: 0,
    failOpen: false,
    maxTokens: KEYWORDS_MAX_TOKENS,
  },
} as const satisfies Record<'C1' | 'KEYWORDS', OrcaClassPolicy>;

/** ルーターがコンソールに無い間は var で素のモデルへ逃がせる（ADR-0004: 手動設定を正にしない） */
export const DEFAULT_COLLECT_ROUTER = 'orcarouter/rs-collect';
export const DEFAULT_REVIEW_ROUTER = 'orcarouter/rs-review';

/** 先頭は primary。重複を除き 5 本まで。未解決の orcarouter/{name} は Orca が飛ばす */
export function fallbackChain(primary: string, rest: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of [primary, ...rest]) {
    if (out.includes(id)) continue;
    out.push(id);
    if (out.length >= MAX_FALLBACKS) break;
  }
  return out;
}

/**
 * 1 段目（収集）: `summary` から検索語を作るだけ。無料プール優先。
 * 回数が最も出る段なので、ここを $0 に寄せる（ADR-0005 §3）。
 */
export function collectPolicy(env: Env): OrcaClassPolicy {
  const model = env.ORCA_ROUTER_COLLECT || DEFAULT_COLLECT_ROUTER;
  return {
    slot: 'cron',
    model,
    fallbacks: fallbackChain(model, COLLECT_CHAIN),
    temperature: 0,
    failOpen: false,
    maxTokens: COLLECT_MAX_TOKENS,
  };
}

/**
 * 2 段目（レビュー）: 要約・論点整理。品質の下限を割らせない。
 * 受け皿は同格のみで、安価モデルへ落とさない（ADR-0005 §5）。
 * Named Router が無いときはチェーンの次（flash / haiku）へ落ちる。
 */
export function reviewPolicy(env: Env): OrcaClassPolicy {
  const model = env.ORCA_ROUTER_REVIEW || DEFAULT_REVIEW_ROUTER;
  return {
    slot: 'interactive',
    model,
    fallbacks: fallbackChain(model, REVIEW_CHAIN),
    temperature: 0,
    failOpen: false,
    maxTokens: REVIEW_MAX_TOKENS,
  };
}

/** トレンドは 2 段目と同じ宛先。出力だけ長い（切れると JSON が壊れる） */
export function trendPolicy(env: Env): OrcaClassPolicy {
  return { ...reviewPolicy(env), maxTokens: TREND_MAX_TOKENS };
}
