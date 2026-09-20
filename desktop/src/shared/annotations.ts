// PDF への書き込み（FR-14）。
//
// **PDF 本体には一切書き戻さない**（C-08）。
// 座標はページ幅・高さに対する比で持つので、拡大率を変えても位置がずれない。
//
//   highlight … 文字を選んで塗る。rect_json に矩形の配列
//   ink       … ペンで書く。path_json に点の配列
//
// コメントはどちらにも付けられる。未公開の思考なので外に出さない（C-01）。

import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';

export type AnnotationKind = 'highlight' | 'ink';

/** ページ幅・高さに対する比（0〜1）。拡大率に依存しない */
export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NormPoint {
  x: number;
  y: number;
}

export interface AnnotationRow {
  annotation_id: string;
  page: number;
  kind: AnnotationKind;
  rect_json: string | null;
  path_json: string | null;
  stroke_width: number | null;
  quote: string | null;
  color: string | null;
  comment: string | null;
  created_at: string;
}

export interface HighlightInput {
  page: number;
  rects: NormRect[];
  quote: string;
  color: string;
  comment?: string | null;
}

export interface InkInput {
  page: number;
  points: NormPoint[];
  color: string;
  strokeWidth: number;
  comment?: string | null;
}

function assertNormalized(values: number[]): void {
  for (const v of values) {
    if (!Number.isFinite(v)) throw new Error('座標が数値でない');
    // 比なので 0〜1 の外は座標の取り違え。静かに描画がずれるより落とす
    if (v < -0.5 || v > 1.5) throw new Error(`座標が 0〜1 の比になっていない: ${v}`);
  }
}

export function addHighlight(db: Db, attachmentId: string, a: HighlightInput): string {
  if (a.rects.length === 0) throw new Error('ハイライトの範囲が空');
  assertNormalized(a.rects.flatMap((r) => [r.x, r.y, r.w, r.h]));

  const id = randomUUID();
  db.prepare(
    `INSERT INTO annotations
       (annotation_id, attachment_id, page, kind, rect_json, quote, color, comment)
     VALUES (?, ?, ?, 'highlight', ?, ?, ?, ?)`,
  ).run(id, attachmentId, a.page, JSON.stringify(a.rects), a.quote, a.color, a.comment ?? null);
  return id;
}

export function addInk(db: Db, attachmentId: string, a: InkInput): string {
  // 点が 1 つだけの線は描いても見えない。押し間違いを保存しない
  if (a.points.length < 2) throw new Error('線が短すぎる');
  assertNormalized(a.points.flatMap((p) => [p.x, p.y]));

  const id = randomUUID();
  db.prepare(
    `INSERT INTO annotations
       (annotation_id, attachment_id, page, kind, path_json, stroke_width, color, comment)
     VALUES (?, ?, ?, 'ink', ?, ?, ?, ?)`,
  ).run(id, attachmentId, a.page, JSON.stringify(a.points), a.strokeWidth, a.color, a.comment ?? null);
  return id;
}

export function listAnnotations(db: Db, attachmentId: string): AnnotationRow[] {
  return db
    .prepare(
      `SELECT annotation_id, page, kind, rect_json, path_json, stroke_width, quote, color, comment, created_at
       FROM annotations WHERE attachment_id = ?
       ORDER BY page, created_at`,
    )
    .all(attachmentId) as unknown as AnnotationRow[];
}

/** コメントの付け外し。空文字は「コメント無し」として NULL に倒す */
export function setComment(db: Db, annotationId: string, comment: string): void {
  const body = comment.trim();
  db.prepare(
    "UPDATE annotations SET comment = ?, updated_at = datetime('now') WHERE annotation_id = ?",
  ).run(body.length > 0 ? body : null, annotationId);
}

export function removeAnnotation(db: Db, annotationId: string): void {
  db.prepare('DELETE FROM annotations WHERE annotation_id = ?').run(annotationId);
}

/** 文献の全添付にまたがる書き込みの件数。一覧に出すため */
export function countAnnotations(db: Db, referenceId: string) {
  const r = db
    .prepare(
      `SELECT
         SUM(CASE WHEN a.kind = 'highlight' THEN 1 ELSE 0 END) AS highlights,
         SUM(CASE WHEN a.kind = 'ink' THEN 1 ELSE 0 END) AS inks,
         SUM(CASE WHEN a.comment IS NOT NULL AND TRIM(a.comment) <> '' THEN 1 ELSE 0 END) AS comments
       FROM annotations a
       JOIN attachments t ON t.attachment_id = a.attachment_id
       WHERE t.reference_id = ?`,
    )
    .get(referenceId) as { highlights: number | null; inks: number | null; comments: number | null };

  return {
    highlights: r.highlights ?? 0,
    inks: r.inks ?? 0,
    comments: r.comments ?? 0,
  };
}
