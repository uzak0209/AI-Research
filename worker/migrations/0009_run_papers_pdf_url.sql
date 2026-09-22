-- OA の直 PDF URL。デスクトップが取得に使う。PDF バイトはクラウドに置かない（ADR-0003）
ALTER TABLE run_papers ADD COLUMN pdf_url TEXT;
