-- 収集で LLM が推測した略語。隠さず同期して見せる（C-07, ADR-0005）
ALTER TABLE runs ADD COLUMN search_terms_json TEXT;
