-- ADR-0005 §9・§10: 収集パイプライン（1 段目・2 段目・トレンド）の LLM 呼び出しを
-- 1 呼び出し 1 行で記録する。router-retro の内省・scripts/retro-metrics.mjs の材料。
--
-- llm_usage（日次×宛先で積み上げる集計行。NFR-04 の利用上限判定用）とは別の表にする。
-- llm_usage は全 endpoint（対話含む）を横断した利用者単位の上限判定が目的で、
-- run 単位に紐付かない。llm_calls は run_id を持つ収集パイプラインの呼び出しだけを、
-- 集計せず 1 行ずつ残す（宛先ごとの比較・受け皿発生率・失敗理由の内訳に生データが要るため）。
--
-- 対話専用の endpoint（/bff/keywords, /bff/bibliography, ログインなしの /bff/trends 単発）は
-- runs に紐付かないので run_id は NULL のまま持たない（このマイグレーションでは書かない）。
-- run_id に外部キー制約は付けない。1 段目の呼び出しは runs.save()（run の確定）より前に
-- 起きるため、外部キーだと FK 違反で落ちる（runs 行がまだ無い）。参照整合性より
-- 呼び出しの取りこぼしを避けることを優先する（C-07: 測ったものを欠かさず残す）。
CREATE TABLE llm_calls (
  call_id          TEXT PRIMARY KEY,
  run_id           TEXT,
  endpoint         TEXT NOT NULL,
  -- 監査に本文を残さない（ADR-0002）。残すのは宛先・分類・数量だけ
  classification   TEXT NOT NULL CHECK (classification IN ('C1', 'C2', 'C3')),
  stage            TEXT NOT NULL CHECK (stage IN ('1段目', '2段目', 'retro')),
  -- Named Router 名。C1 直指定（書誌補完等）はここに入らないので NULL
  router           TEXT,
  -- 要求した宛先。Named Router 名またはモデル ID
  requested_model  TEXT,
  -- 実際に応答したモデル
  resolved_model   TEXT,
  -- 要求と応答が食い違った＝受け皿へ落ちた先。落ちていなければ NULL
  fallback_target  TEXT,
  tokens_in        INTEGER NOT NULL DEFAULT 0,
  tokens_out       INTEGER NOT NULL DEFAULT 0,
  -- 取れなかった／失敗した呼び出しは NULL（0 と「不明」を混ぜない。C-07）
  cost_usd         REAL,
  duration_ms      INTEGER,
  -- コード側の出力検査の結果。未実装の間は NULL のまま（C-07: 測っていないことを偽らない）
  guardrail_result TEXT,
  -- 失敗時のみ: 5xx | 429 | timeout | invalid_format。成功時は NULL
  failure_reason   TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- run 単位の内省（1 段目→2 段目到達率など）と、期間集計の両方で引く
CREATE INDEX idx_llm_calls_run_id ON llm_calls(run_id);
CREATE INDEX idx_llm_calls_created_at ON llm_calls(created_at);
