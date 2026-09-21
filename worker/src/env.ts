/** Worker のバインディング。秘密は wrangler secret。Cookie セッションは持たない（ADR-0004） */
export interface Env {
  DB: D1Database;
  IDEMPOTENCY: KVNamespace;
  COLLECT_QUEUE: Queue<CollectMessage>;
  ENVIRONMENT: string;
  CONSENT_VERSION: string;
  /** 利用者あたり 1 日の LLM 呼び出し上限（NFR-04）。文字列で来る */
  LLM_DAILY_CALL_LIMIT: string;
  /** 未設定の間は JWT を発行・検証しない。IdP が決まるまで /runs は 501 */
  JWT_SIGNING_KEY?: string;
  /**
   * C1（interactive）用。cron / sensitive は C2/C3 を足すときに分ける（ADR-0002）。
   * 未設定なら BFF は 501。クライアントに置かない（C-06）
   */
  ORCAROUTER_API_KEY?: string;
  /** C1 interactive。未設定なら ORCAROUTER_API_KEY を使う */
  ORCAROUTER_API_KEY_INTERACTIVE?: string;
  ORCAROUTER_API_KEY_CRON?: string;
  ORCAROUTER_API_KEY_SENSITIVE?: string;
  /** OpenAlex。2026-02 以降は共有 IP からの無鍵呼び出しが落ちる。クライアントに置かない（C-06） */
  OPENALEX_API_KEY?: string;
  /** TypeSafe Jev（C1 書誌の判定）。クライアントに置かない（C-06, ADR-0002） */
  JEV_API_KEY?: string;
}

/** 1 メッセージ = 1（プロジェクト × ソース）。実行を分けて 10ms 枠を稼ぐ */
export interface CollectMessage {
  run_id: string;
  project_id: string;
  summary: string;
  source: string;
  run_date: string;
}
