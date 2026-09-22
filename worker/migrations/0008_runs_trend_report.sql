-- 収集 1 回の公開論文から出したトレンドと次テーマ。隠さず同期する（FR-09, C-07）
ALTER TABLE runs ADD COLUMN trend_summary TEXT;
ALTER TABLE runs ADD COLUMN themes_json TEXT;
