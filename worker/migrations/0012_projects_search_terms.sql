-- 利用者が設定で確定した検索語。収集 1 段目はこれがあれば LLM で作り直さない。
ALTER TABLE projects ADD COLUMN search_terms_json TEXT;
