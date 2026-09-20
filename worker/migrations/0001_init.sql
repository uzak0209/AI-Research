-- ADR-0001 のデータ配置と docs/er-diagram.md のクラウド側に対応する。
--
-- 境界: クラウドは「誰の・どのプロジェクトに・いつ・何が集まったか」まで。
--       論文への判断と手元の文章はローカル。ここには公開情報しか置かない。
--
-- 持たないもの:
--   - クラウド側の papers マスタ表（run_papers に論文情報を直接持つ。結合を減らす）
--   - ユーザー名・メール（本人確認は OAuth subject のみ）
--   - 判定結果（未公開データ由来。書き戻し経路を作らない。C-01）

CREATE TABLE users (
  user_id       TEXT PRIMARY KEY,
  oauth_subject TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  -- 日次収集が何を集めるか判断する唯一の材料であり、
  -- 同時にクラウドに出る唯一のユーザー情報（ADR-0001）
  summary    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_projects_user ON projects(user_id);

CREATE TABLE runs (
  run_id             TEXT PRIMARY KEY,           -- = レポート ID
  project_id         TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  run_date           TEXT NOT NULL,              -- UTC の YYYY-MM-DD
  -- FR-08 / C-07: 「0 件」と「取得失敗」を混ぜない
  status             TEXT NOT NULL CHECK (status IN ('ok', 'empty', 'failed', 'partial')),
  -- 欠けた依存だけを記録する。成功したソースは書かない
  failed_sources_json TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  -- cron・Queues とも at-least-once。同じ日の重複実行を無視できるようにする
  UNIQUE (project_id, run_date)
);

CREATE INDEX idx_runs_project_created ON runs(project_id, created_at);

CREATE TABLE run_papers (
  run_id       TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  external_id  TEXT NOT NULL,                    -- ソース内 ID / DOI
  source       TEXT NOT NULL,
  title        TEXT NOT NULL,
  abstract     TEXT,
  url          TEXT,
  published_at TEXT,
  -- summary と照らした粗い絞り込み。精密な採点は未公開データが要るのでローカル（ADR-0001）
  coarse_score REAL,
  PRIMARY KEY (run_id, external_id)
);

-- NFR-04: 利用者単位の上限。LLM 呼び出し回数だけを数える。
-- HTTP リクエスト全部は数えない（D1 の 1 日 10 万行書き込みに収めるため）
CREATE TABLE llm_usage (
  user_id    TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  usage_date TEXT NOT NULL,                      -- UTC の YYYY-MM-DD
  endpoint   TEXT NOT NULL,
  -- 監査に本文を残さない（ADR-0002）。残すのは endpoint・分類・モデル・トークン数
  classification TEXT NOT NULL CHECK (classification IN ('C1', 'C2', 'C3')),
  model      TEXT,
  calls      INTEGER NOT NULL DEFAULT 0,
  tokens     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, usage_date, endpoint)
);
