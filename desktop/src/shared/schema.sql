-- ローカルストア（docs/er-diagram.md のローカル側）。
-- GUI と CLI が同じこのファイルを読み書きする（FR-11。二重管理しない）。
--
-- ここには未公開データが入る。外に出さない（C-01）。
-- DB ファイル自体は暗号化されない。秘密は settings に safeStorage で入れる（ADR-0001）。
--
-- ER 図からの逸脱（実測に基づく）:
--   - `references` は SQLite の予約語で CREATE TABLE できないため `reference_items` にした
--   - `nearest_claim_id` は chunks を指すので `nearest_chunk_id`（INTEGER）にした

CREATE TABLE IF NOT EXISTS projects (
  project_id   TEXT PRIMARY KEY,           -- クラウドと同じ ID
  title        TEXT NOT NULL,
  -- クラウドに出る唯一のユーザー情報。日次収集の判断材料（ADR-0001）
  summary      TEXT NOT NULL DEFAULT '',
  -- プロジェクトに 1 つ固定。別モデルのベクトルは比較できない
  embed_model  TEXT NOT NULL,
  last_run_id  TEXT,                        -- 同期位置。settings には置かない
  last_search_terms TEXT,                   -- 直近の収集で LLM が推測した略語 JSON。見せる（C-07）
  -- 作業フォルダ（references / mypaper / claims）。未設定可。索引の正本は SQLite
  root_path    TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 手元のファイル 1 つ。kind=data（研究データ）と kind=manuscript（執筆中原稿）を
-- 同じ表に置くのは、読み込み・分割・検索の扱いが同じため
CREATE TABLE IF NOT EXISTS documents (
  document_id TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('data', 'manuscript')),
  path        TEXT,
  format      TEXT CHECK (format IN ('md', 'tex', 'typ', 'txt')),
  hash        TEXT,                         -- 変更時のみ再索引するため
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id, kind);

-- 検索できる大きさに切った文章。section は根拠提示に使う。
-- 採点で「自分のどの主張に近いか」を出す元でもある
CREATE TABLE IF NOT EXISTS chunks (
  chunk_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
  section     TEXT,
  text        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);

-- 取り込んだ論文候補と、手元でしか出せない採点。
-- **有効／除外の列を持たない。** 実データで閾値が引けなかったため（C-07, ADR-0001）
CREATE TABLE IF NOT EXISTS papers (
  paper_id          TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  run_id            TEXT,
  external_id       TEXT,
  source            TEXT,
  title             TEXT NOT NULL,
  authors           TEXT,                   -- OpenAlex authorships。ライブラリへ渡す（FR-05）
  abstract          TEXT,
  url               TEXT,
  published_at      TEXT,
  coarse_score      REAL,                   -- クラウドの粗選別
  problem_excerpt   TEXT,                   -- クラウドの課題意識抜粋（FR-15）
  pdf_url           TEXT,                   -- OA 直リンク（取得済み／解決済み）
  fulltext_path     TEXT,                   -- candidates/{paper_id}.pdf など
  fulltext          TEXT,                   -- 採点用に抽出した本文（無ければ未採点・mypaper あり時）
  -- 読む順: mypaper↔全文 max-cos、または blend（概要×0.7＋最近傍関連技術×0.3）
  relevance         REAL,
  sim_summary       REAL,
  nearest_chunk_id  INTEGER REFERENCES chunks(chunk_id) ON DELETE SET NULL,
  nearest_chunk_sim REAL,
  embed_model       TEXT,                   -- 替えたら採点し直す必要がある
  scored_at         TEXT,                   -- NULL = 未採点。順位を捏造しない
  in_library        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_papers_rank ON papers(project_id, relevance DESC);
-- 未採点の行を拾うだけで再開できる。採点キュー表は作らない
CREATE INDEX IF NOT EXISTS idx_papers_unscored ON papers(project_id, scored_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_papers_external ON papers(project_id, source, external_id);
CREATE INDEX IF NOT EXISTS idx_papers_run ON papers(project_id, run_id);

-- アプリ内参考文献ライブラリの本体（FR-05）。
-- `references` は SQLite の予約語なので reference_items
CREATE TABLE IF NOT EXISTS reference_items (
  reference_id TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  paper_id     TEXT REFERENCES papers(paper_id) ON DELETE SET NULL,  -- 日次候補由来なら
  title        TEXT NOT NULL,
  authors      TEXT,
  year         INTEGER,
  doi          TEXT,
  url          TEXT,
  venue        TEXT,                        -- 掲載誌・会議
  abstract     TEXT,
  item_type    TEXT NOT NULL DEFAULT 'article',
  -- 重要な文献に付ける印。フィルタの軸になる
  starred      INTEGER NOT NULL DEFAULT 0,
  -- 読んだか。未読／読んでいる／読んだ
  read_status  TEXT NOT NULL DEFAULT 'unread'
                 CHECK (read_status IN ('unread', 'reading', 'read')),
  -- \cite{} に使う識別子。プロジェクト内で一意（FR-12）
  bibtex_key   TEXT NOT NULL,
  added_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- タグ。コレクションより軽い分類（FR-05）
CREATE TABLE IF NOT EXISTS tags (
  tag_id     TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  color      TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name ON tags(project_id, name);

CREATE TABLE IF NOT EXISTS reference_tags (
  reference_id TEXT NOT NULL REFERENCES reference_items(reference_id) ON DELETE CASCADE,
  tag_id       TEXT NOT NULL REFERENCES tags(tag_id) ON DELETE CASCADE,
  PRIMARY KEY (reference_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_reftags_tag ON reference_tags(tag_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_refs_key ON reference_items(project_id, bibtex_key);
-- DOI が一致する項目は既存とみなし、重複エントリを作らない（ADR-0003）
CREATE UNIQUE INDEX IF NOT EXISTS idx_refs_doi ON reference_items(project_id, doi) WHERE doi IS NOT NULL;

CREATE TABLE IF NOT EXISTS collections (
  collection_id TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  name          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_items (
  collection_id TEXT NOT NULL REFERENCES collections(collection_id) ON DELETE CASCADE,
  reference_id  TEXT NOT NULL REFERENCES reference_items(reference_id) ON DELETE CASCADE,
  PRIMARY KEY (collection_id, reference_id)
);

-- 添付 PDF（FR-14）。実体はローカル。クラウドに置かない（C-01）
CREATE TABLE IF NOT EXISTS attachments (
  attachment_id TEXT PRIMARY KEY,
  reference_id  TEXT NOT NULL REFERENCES reference_items(reference_id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'pdf',
  -- 原本が外部で差し替えられたときに注釈の位置がずれることを検知するため
  hash          TEXT,
  added_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_attachments_ref ON attachments(reference_id);

-- ハイライト・ペン書き込み・コメント。**PDF 本体には書き戻さない**（C-08）
CREATE TABLE IF NOT EXISTS annotations (
  annotation_id TEXT PRIMARY KEY,
  attachment_id TEXT NOT NULL REFERENCES attachments(attachment_id) ON DELETE CASCADE,
  page          INTEGER NOT NULL,
  -- highlight = 文字を選んで塗る / ink = ペンで書く
  kind          TEXT NOT NULL DEFAULT 'highlight' CHECK (kind IN ('highlight', 'ink')),
  -- highlight のときだけ使う。ページ幅・高さに対する比の矩形の配列
  rect_json     TEXT,
  -- ink のときだけ使う。ページ幅・高さに対する比の点の配列
  path_json     TEXT,
  stroke_width  REAL,
  quote         TEXT,
  color         TEXT,
  -- 書き込んだ本人のコメント。未公開の思考なので外に出さない（C-01）
  comment       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_annotations_attachment ON annotations(attachment_id, page);

-- 収集 1 回の報告（いつ・トレンド・次テーマ）。論文行は papers.run_id で辿る
CREATE TABLE IF NOT EXISTS survey_reports (
  run_id       TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  run_date     TEXT NOT NULL,
  status       TEXT NOT NULL,
  search_terms TEXT,
  trend        TEXT,
  themes_json  TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_survey_reports_project ON survey_reports(project_id, run_date DESC, created_at DESC);

-- 文献ごとの自由記述。未公開の思考なので外に出さない（C-01）。
-- 1 文献 1 本にする。複数あると「どれが本文か」が曖昧になる
CREATE TABLE IF NOT EXISTS notes (
  reference_id TEXT PRIMARY KEY REFERENCES reference_items(reference_id) ON DELETE CASCADE,
  body         TEXT NOT NULL DEFAULT '',
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 接続・機能オフ（C-03）・同意。秘密は safeStorage で暗号化して入れる
CREATE TABLE IF NOT EXISTS settings (
  key       TEXT PRIMARY KEY,
  value     TEXT,
  encrypted INTEGER NOT NULL DEFAULT 0
);

-- 引用ファイル書き出し先ごとの前回書き出し記録（FR-12, C-08）。
-- マーカーが消えたとき「初回」と区別し、マーカー内の手編集を検知するために持つ
CREATE TABLE IF NOT EXISTS cite_exports (
  path       TEXT PRIMARY KEY,
  inner_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
