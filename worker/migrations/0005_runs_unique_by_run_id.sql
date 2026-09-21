-- 自発調査（FR-17）: 同日に複数 run を持てるよう、(project_id, run_date) 一意を外す。
-- 一意は run_id（PK）のみ。日次は {project_id}:{YYYY-MM-DD}、手動は {project_id}:manual:{unix}。

PRAGMA foreign_keys = OFF;

CREATE TABLE runs_new (
  run_id              TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  run_date            TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('ok', 'empty', 'failed', 'partial')),
  failed_sources_json TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO runs_new (run_id, project_id, run_date, status, failed_sources_json, created_at)
SELECT run_id, project_id, run_date, status, failed_sources_json, created_at FROM runs;

DROP TABLE runs;
ALTER TABLE runs_new RENAME TO runs;

CREATE INDEX idx_runs_project_created ON runs(project_id, created_at);

PRAGMA foreign_keys = ON;
