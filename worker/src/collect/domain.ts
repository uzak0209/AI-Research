import { z } from 'zod';

/** 収集ソース。アダプタで足す（ADR-0001 の拡張点） */
export const SOURCES = ['openalex'] as const;

export const collectMessageSchema = z.object({
  run_id: z.string().min(1),
  project_id: z.string().min(1),
  summary: z.string(),
  source: z.string().min(1),
  run_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // 収集段の LLM 利用を誰の分として数えるか（NFR-04）。
  // 配送中の古いメッセージには無いので optional。無ければ project から引く
  user_id: z.string().min(1).optional(),
  search_terms: z.array(z.string().trim().min(1).max(24)).max(40).optional(),
});

/**
 * 粗い採点。**文字列一致の水準に留める**（ADR-0004）。
 * 埋め込みによる精密な採点はローカル（ADR-0001, C-09）
 *
 * ASCII は 4 文字以上。区切りの無い日本語はカタカナ連続・漢字連続を語にする。
 */
export function coarseScore(summary: string, text: string): number {
  const terms = extractTerms(summary);
  if (terms.size === 0) return 0;
  const hay = text.toLowerCase();
  let hit = 0;
  for (const t of terms) if (hay.includes(t)) hit++;
  return hit / terms.size;
}

function extractTerms(summary: string): Set<string> {
  const terms = new Set<string>();
  const lower = summary.toLowerCase();
  for (const t of lower.split(/[^a-z0-9]+/)) {
    if (t.length >= 4) terms.add(t);
  }
  for (const t of summary.match(/[\u30a1-\u30f4]{3,}/g) ?? []) {
    terms.add(t);
  }
  for (const t of summary.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    terms.add(t);
  }
  return terms;
}

/**
 * サーキットブレーカーの閾値（ADR-0005 §7）。連続失敗がこの回数に達すると
 * その日はその project の呼び出しを止める。設定が壊れていたら 1 = 最初の失敗で止める（fail closed）
 */
export function circuitBreakerThreshold(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

export type ScoredPaper = {
  external_id: string;
  title: string;
  authors: string | null;
  abstract: string | null;
  url: string | null;
  published_at: string | null;
  /** 掲載誌・会議名。候補の時点で揃える（書誌補完を呼ばないため） */
  venue?: string | null;
  item_type?: string | null;
  /** OA の直 PDF。無ければ null = 未取得（C-07） */
  pdf_url?: string | null;
  coarse_score: number;
  problem_excerpt: string | null;
};
