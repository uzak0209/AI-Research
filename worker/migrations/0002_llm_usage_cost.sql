-- ADR-0005 §8: 利用上限と内省の材料を「呼び出し回数」から実額へ広げる。
--
-- 既存の llm_usage をそのまま使う（新表を作らない）。PK は (user_id, usage_date, endpoint)
-- のままなので、モデル別の内訳は取れない。推移グラフに必要なのは日次の合計なので足りる。
-- モデル別が要るようになったら PK の作り直しを別マイグレーションで行う。
--
-- 監査に本文を残さない方針（ADR-0002）は変えない。足すのは金額と解決モデルだけ。

-- OrcaRouter の usage.cost_usd を合算して入れる。
-- 取得できなかった呼び出しは加算しない（0 と「不明」を混ぜないため、件数は calls で見る）。
ALTER TABLE llm_usage ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;

-- 実際に応答したモデル（X-Orca-Resolved-Model）。
-- 要求した model と食い違った回数が、受け皿へ落ちた回数になる。
ALTER TABLE llm_usage ADD COLUMN resolved_model TEXT;

-- 自前フォールバックが発火した回数（ADR-0005 §5）。calls のうち何回かを表す。
ALTER TABLE llm_usage ADD COLUMN fallback_calls INTEGER NOT NULL DEFAULT 0;
