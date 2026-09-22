-- 生の JSON がそのまま trend_summary に入った行を消す。
-- 出力が長さ上限で切れて JSON が壊れ、`{"trend": "…` を本文として保存していた。
-- 壊れた本文を残すより「未着」にして取り直させる（C-07）。
UPDATE runs
   SET trend_summary = NULL,
       themes_json = NULL
 WHERE trend_summary IS NOT NULL
   AND trim(trend_summary) LIKE '{%'
   AND trim(trend_summary) LIKE '%"trend"%';
