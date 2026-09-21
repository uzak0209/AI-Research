/** Worker のバインディング。秘密は wrangler secret。Cookie セッションは持たない（ADR-0004） */
export interface Env {
  DB: D1Database;
  IDEMPOTENCY: KVNamespace;
  COLLECT_QUEUE: Queue<CollectMessage>;
  ENVIRONMENT: string;
  CONSENT_VERSION: string;
  /** 利用者あたり 1 日の LLM 呼び出し上限（NFR-04）。文字列で来る */
  LLM_DAILY_CALL_LIMIT: string;
  /** 未設定の間は JWT を発行・検証しない */
  JWT_SIGNING_KEY?: string;
  /** Google OAuth の client_id。公開してよい。未設定ならログインは 501 */
  GOOGLE_OAUTH_CLIENT_ID?: string;
  /** Google OAuth の client_secret。クライアントに置かない（C-06） */
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  /**
   * C1（interactive）用。cron / sensitive は C2/C3 を足すときに分ける（ADR-0002）。
   * 未設定なら BFF は 501。クライアントに置かない（C-06）
   */
  ORCAROUTER_API_KEY?: string;
  /** C1 interactive。未設定なら ORCAROUTER_API_KEY を使う */
  ORCAROUTER_API_KEY_INTERACTIVE?: string;
  ORCAROUTER_API_KEY_CRON?: string;
  ORCAROUTER_API_KEY_SENSITIVE?: string;
  /**
   * 段ごとの Named Router 名（ADR-0005 §2）。wrangler.jsonc の vars が正本。
   * コンソールにルーターが無い間は素のモデル ID を入れて逃がせる
   */
  ORCA_ROUTER_COLLECT?: string;
  ORCA_ROUTER_REVIEW?: string;
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
  /** 収集段の LLM 利用の帰属先。配送中の古いメッセージには無い */
  user_id?: string;
}
