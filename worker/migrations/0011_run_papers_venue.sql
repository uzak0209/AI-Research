-- 掲載誌と引用の種別。候補の時点で書誌を揃え、保存のたびに
-- 書誌補完（/bff/bibliography）を呼ばないようにする（ADR-0002 / ADR-0003）
ALTER TABLE run_papers ADD COLUMN venue TEXT;
ALTER TABLE run_papers ADD COLUMN item_type TEXT;
