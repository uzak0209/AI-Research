-- ADR-0005 §4-1 / §10: ルーター（宛先）ごとに推論時間・コスト・トークンを比べられるようにする。
--
-- 0002 までの llm_usage は PK が (user_id, usage_date, endpoint) で、
-- 1 日 1 endpoint につき 1 行しか持てない。model は上書きされるため、
-- 「どの宛先が速くて安かったか」を後から比べられない。
--
-- PK に model（要求した宛先）と resolved_model（実際に応答したモデル）を足す。
-- model には Named Router 名（orcarouter/rs-review 等）もモデル ID も入る。
-- ルーターへ移行しても列を増やさずに同じ比較ができる。
--
-- 推論時間は合計で持つ。この表は upsert で積み上げる集計行なので、
-- 1 回分の値を置くと最後の呼び出しで上書きされてしまう。平均は sum / calls で出す。
--
-- SQLite は PK を ALTER できないので作り直す。

CREATE TABLE llm_usage_new (
  user_id        TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  usage_date     TEXT NOT NULL,                  -- UTC の YYYY-MM-DD
  endpoint       TEXT NOT NULL,
  -- 監査に本文を残さない（ADR-0002）。残すのは宛先・分類・数量だけ
  classification TEXT NOT NULL CHECK (classification IN ('C1', 'C2', 'C3')),
  -- 要求した宛先。Named Router 名またはモデル ID。不明なら空文字
  model          TEXT NOT NULL DEFAULT '',
  -- 実際に応答したモデル（X-Orca-Resolved-Model / X-Orca-Fallback-Model）
  resolved_model TEXT NOT NULL DEFAULT '',
  calls          INTEGER NOT NULL DEFAULT 0,
  tokens         INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL    NOT NULL DEFAULT 0,     -- usage.cost_usd の合計
  latency_ms_sum INTEGER NOT NULL DEFAULT 0,     -- 平均は latency_ms_sum / calls
  fallback_calls INTEGER NOT NULL DEFAULT 0,     -- 要求と解決が食い違った回数
  PRIMARY KEY (user_id, usage_date, endpoint, model, resolved_model)
);

-- 既存行の model には servedModel()（＝実際に応答したモデル）が入っている。
-- 要求した宛先は残っていないので、resolved_model へ移し、model は空にする。
-- 過去分だけ「要求不明」になるが、値を取り違えるよりよい（C-07）。
INSERT INTO llm_usage_new
  (user_id, usage_date, endpoint, classification, model, resolved_model,
   calls, tokens, cost_usd, latency_ms_sum, fallback_calls)
SELECT
  user_id, usage_date, endpoint, classification,
  '', COALESCE(model, ''),
  calls, tokens, cost_usd, 0, fallback_calls
FROM llm_usage;

DROP TABLE llm_usage;

ALTER TABLE llm_usage_new RENAME TO llm_usage;

-- 日次の集計と、宛先ごとの比較で引く
CREATE INDEX idx_llm_usage_date ON llm_usage (usage_date);
