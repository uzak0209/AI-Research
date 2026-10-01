-- ADR-0005 §10: problem_excerpt の照合結果（abstract に実在する逐語引用か）。
-- FR-16・C-07 の「捏造しない」を実測するための列。捏造率はこの列から出す。
--
-- NULL   = problem_excerpt が無い（抽出できなかった。未実施と区別しない）
-- 1      = abstract 内に逐語で見つかった
-- 0      = problem_excerpt はあるが abstract 内に見つからない（捏造の疑い）
ALTER TABLE run_papers ADD COLUMN problem_excerpt_verified INTEGER;
