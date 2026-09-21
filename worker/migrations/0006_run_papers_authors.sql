-- 公開書誌の著者。OpenAlex authorships から取る（FR-05）。図書館へ渡す材料。
ALTER TABLE run_papers ADD COLUMN authors TEXT;
