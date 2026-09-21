// 採点用に候補 PDF を candidates/ へ取り、本文を papers に載せる（ADR-0003）。
// ライブラリ行は作らない。既存ファイルは上書きしない（C-08）。

import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import type { Db } from './db.js';
import { extractFullTextFromPdf } from './pdf-import.js';
import {
  listPapersNeedingFulltext,
  setPaperFulltext,
  setPaperPdfUrl,
} from './repo.js';
import { candidatePdfPath, ensureCandidatesDir } from './workspace.js';
import { httpsPdfUrl } from '../bibliography/domain/oa-url.js';
import type { BibliographyGateway } from '../bibliography/application/ports.js';
import type { PdfStore } from '../bibliography/application/ports.js';

export type CandidatePdfDeps = {
  gateway: BibliographyGateway;
  pdfs: PdfStore;
};

export type CandidatePdfResult = {
  attempted: number;
  extracted: number;
  downloaded: number;
  failed: number;
};

const DOI_RE = /^10\.\d{4,9}\//;

/**
 * 未採点かつ本文が無い候補について、OA 直リンクがあれば PDF を取り本文を抽出する。
 * 失敗は未採点のまま残す（C-07）。
 */
export async function ensureCandidateFulltexts(
  db: Db,
  projectId: string,
  root: string,
  deps: CandidatePdfDeps,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<CandidatePdfResult> {
  ensureCandidatesDir(root);
  const papers = listPapersNeedingFulltext(db, projectId, opts.limit ?? 200);
  const result: CandidatePdfResult = { attempted: 0, extracted: 0, downloaded: 0, failed: 0 };

  for (const p of papers) {
    if (opts.signal?.aborted) break;
    result.attempted++;

    const dest = candidatePdfPath(root, p.paper_id);
    let path = p.fulltext_path && existsSync(p.fulltext_path) ? p.fulltext_path : null;
    if (!path && existsSync(dest)) path = dest;

    if (!path) {
      const url = await resolvePdfUrl(db, p, deps);
      if (!url) {
        result.failed++;
        continue;
      }
      const dl = await deps.pdfs.download(url, dest);
      if (dl === 'ok' || dl === 'exists') {
        path = dest;
        if (dl === 'ok') result.downloaded++;
      } else {
        result.failed++;
        continue;
      }
    }

    try {
      const bytes = new Uint8Array(readFileSync(path));
      const text = await extractFullTextFromPdf(bytes);
      if (!text) {
        result.failed++;
        continue;
      }
      setPaperFulltext(db, p.paper_id, { path, text });
      result.extracted++;
    } catch {
      result.failed++;
    }
  }

  return result;
}

async function resolvePdfUrl(
  db: Db,
  p: { paper_id: string; title: string; url: string | null; external_id: string | null; pdf_url: string | null },
  deps: CandidatePdfDeps,
): Promise<string | null> {
  const cached = httpsPdfUrl(p.pdf_url);
  if (cached) return cached;
  const fromUrl = httpsPdfUrl(p.url);
  if (fromUrl && /\.pdf(?:[?#]|$)/i.test(fromUrl)) return fromUrl;

  const doi = p.external_id && DOI_RE.test(p.external_id) ? p.external_id : null;
  if (!doi && !p.title.trim()) return null;

  try {
    const got = await deps.gateway.complete({
      title: p.title.trim() || undefined,
      doi: doi ?? undefined,
      url: p.url ?? undefined,
    });
    const url = httpsPdfUrl(got?.pdf_url ?? null);
    if (url) setPaperPdfUrl(db, p.paper_id, url);
    return url;
  } catch {
    return null;
  }
}

/**
 * ライブラリ追加時: candidates/ にあれば references/ へコピー。
 * 取り直さない（二重ダウンロード回避）。
 */
export function promoteCandidatePdf(
  root: string,
  paperId: string,
  referencesDest: string,
): string | null {
  const src = existsSync(candidatePdfPath(root, paperId))
    ? candidatePdfPath(root, paperId)
    : null;
  if (!src) return null;
  if (existsSync(referencesDest)) return referencesDest;
  copyFileSync(src, referencesDest);
  return referencesDest;
}
