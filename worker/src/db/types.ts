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
  created_at: string;
}

export interface Runs {
  run_id: string;
  project_id: string;
  run_date: string;
  status: string;
  failed_sources_json: string | null;
  created_at: string;
}

export interface RunPapers {
  run_id: string;
  external_id: string;
  source: string;
  title: string;
  abstract: string | null;
  url: string | null;
  published_at: string | null;
  coarse_score: number | null;
}

export interface LlmUsage {
  user_id: string;
  usage_date: string;
  endpoint: string;
  classification: string;
  model: string | null;
  calls: number;
  tokens: number;
}

export interface DB {
  users: Users;
  projects: Projects;
  runs: Runs;
  run_papers: RunPapers;
  llm_usage: LlmUsage;
}
