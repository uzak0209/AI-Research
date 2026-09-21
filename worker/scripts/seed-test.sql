-- Claude scan が読むための公開データだけ。未公開研究は置かない（C-01）。
-- 対象は user_id = 'test-scan-user' のみ。他環境へは絶対に当てない。
-- 日付は date('now') 相対なので LOOKBACK_DAYS=7 の定時スキャンに毎回入る。

DELETE FROM run_papers WHERE run_id IN (SELECT run_id FROM runs WHERE project_id = 'test-scan-project');
DELETE FROM runs WHERE project_id = 'test-scan-project';
DELETE FROM llm_usage WHERE user_id = 'test-scan-user';
DELETE FROM projects WHERE project_id = 'test-scan-project';
DELETE FROM users WHERE user_id = 'test-scan-user';

INSERT INTO users (user_id, oauth_subject) VALUES ('test-scan-user', 'google:test-scan-user');

INSERT INTO projects (project_id, user_id, title, summary) VALUES (
  'test-scan-project',
  'test-scan-user',
  'Scan fixture',
  'Public transformer language models. Fixture data for Claude scan, not a real research project.'
);

INSERT INTO runs (run_id, project_id, run_date, status, failed_sources_json) VALUES
  ('test-run-ok',      'test-scan-project', date('now', '-1 day'), 'ok',      NULL),
  ('test-run-empty',   'test-scan-project', date('now', '-2 day'), 'empty',   NULL),
  ('test-run-partial', 'test-scan-project', date('now', '-3 day'), 'partial', '["openalex"]');

INSERT INTO run_papers (run_id, external_id, source, title, abstract, url, published_at, coarse_score) VALUES
  (
    'test-run-ok',
    'https://openalex.org/W2964140473',
    'openalex',
    'Attention Is All You Need',
    'We propose a new simple network architecture, the Transformer, based solely on attention mechanisms.',
    'https://arxiv.org/abs/1706.03762',
    '2017-06-12',
    0.91
  ),
  (
    'test-run-ok',
    'https://openalex.org/W2963389646',
    'openalex',
    'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding',
    'We introduce BERT, designed to pre-train deep bidirectional representations from unlabeled text.',
    'https://arxiv.org/abs/1810.04805',
    '2018-10-11',
    0.84
  ),
  (
    'test-run-partial',
    'https://openalex.org/W2555959023',
    'openalex',
    'Deep Residual Learning for Image Recognition',
    'We present a residual learning framework to ease the training of networks that are substantially deeper than those used previously.',
    'https://arxiv.org/abs/1512.03385',
    '2015-12-10',
    0.62
  );

INSERT INTO llm_usage (user_id, usage_date, endpoint, classification, model, calls, tokens) VALUES
  ('test-scan-user', date('now', '-1 day'), 'trends',        'C1', 'gpt-4o-mini', 2, 1800),
  ('test-scan-user', date('now', '-1 day'), 'bibliography',  'C1', 'gpt-4o-mini', 1,  640),
  ('test-scan-user', date('now', '-3 day'), 'trends',        'C1', 'gpt-4o-mini', 1,  900);
