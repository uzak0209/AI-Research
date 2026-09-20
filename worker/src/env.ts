/** Worker のバインディング。秘密は wrangler secret。Cookie セッションは持たない（ADR-0004） */
export interface Env {
  DB: D1Database;
  IDEMPOTENCY: KVNamespace;
  COLLECT_QUEUE: Queue<CollectMessage>;
  ENVIRONMENT: string;
  CONSENT_VERSION: string;
  /** 未設定の間は JWT を発行・検証しない。IdP が決まるまで /runs は 501 */
  JWT_SIGNING_KEY?: string;
}

/** 1 メッセージ = 1（プロジェクト × ソース）。実行を分けて 10ms 枠を稼ぐ */
export interface CollectMessage {
  run_id: string;
  project_id: string;
  summary: string;
  source: string;
  run_date: string;
}
