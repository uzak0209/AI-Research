/**
 * D1 の表型。正本は migrations/。このファイルは `npm run codegen` で作り直す。
 * 手で列を足さない（migration とずれる）。
 */
export interface Users {
  user_id: string;
  oauth_subject: string;
  created_at: string;
}

export interface Projects {
  project_id: string;
  user_id: string;
  title: string;
  summary: string;
  /** 利用者が確定した検索語 JSON。無ければ収集時に LLM で分解する */
  search_terms_json: string | null;
  created_at: string;
}

export interface Runs {
  run_id: string;
  project_id: string;
  run_date: string;
  status: string;
  failed_sources_json: string | null;
  search_terms_json: string | null;
  trend_summary: string | null;
  themes_json: string | null;
  created_at: string;
}

export interface RunPapers {
  run_id: string;
  external_id: string;
  source: string;
  title: string;
  authors: string | null;
  abstract: string | null;
  url: string | null;
  published_at: string | null;
  /** 掲載誌・会議名 */
  venue: string | null;
  /** 引用の種別（article / preprint / inproceedings …） */
  item_type: string | null;
  /** OA の直 PDF。取得はデスクトップ（ADR-0003） */
  pdf_url: string | null;
  coarse_score: number | null;
  problem_excerpt: string | null;
  /** abstract との逐語照合。null=excerpt 無し／1=一致／0=不一致（捏造の疑い） */
  problem_excerpt_verified: number | null;
}

export interface LlmUsage {
  user_id: string;
  usage_date: string;
  endpoint: string;
  classification: string;
  /** 要求した宛先（Named Router 名またはモデル ID） */
  model: string;
  /** 実際に応答したモデル */
  resolved_model: string;
  calls: number;
  tokens: number;
  cost_usd: number;
  /** 合計。平均は latency_ms_sum / calls */
  latency_ms_sum: number;
  fallback_calls: number;
}

/**
 * ADR-0005 §9・§10: 収集パイプラインの LLM 呼び出し。1 呼び出し 1 行。
 * run_id に外部キー制約は無い（1 段目の呼び出しは runs 行の確定より前に起きるため）。
 */
export interface LlmCalls {
  call_id: string;
  /** 対話専用 endpoint は runs に紐付かないため null */
  run_id: string | null;
  endpoint: string;
  classification: string;
  /** 1段目 | 2段目 | retro */
  stage: string;
  /** Named Router 名。C1 直指定は null */
  router: string | null;
  requested_model: string | null;
  resolved_model: string | null;
  /** 受け皿へ落ちた先。落ちていなければ null */
  fallback_target: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number | null;
  duration_ms: number | null;
  /** コード側の出力検査結果。未実装の間は null（C-07） */
  guardrail_result: string | null;
  /** 失敗時のみ: 5xx | 429 | timeout | invalid_format */
  failure_reason: string | null;
  created_at: string;
}

export interface DB {
  users: Users;
  projects: Projects;
  runs: Runs;
  run_papers: RunPapers;
  llm_usage: LlmUsage;
  llm_calls: LlmCalls;
}
