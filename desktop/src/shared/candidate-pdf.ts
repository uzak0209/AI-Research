// 採点用に候補 PDF を candidates/ へ取り、本文を papers に載せる（ADR-0003）。
// ライブラリ行は作らない。既存ファイルは上書きしない（C-08）。

import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import type { Db } from './db.js';
import { extractFromPdf, extractFullTextFromPdf } from './pdf-import.js';
import {
  fillPaperAuthors,
  listPapersMissingAuthors,
  listPapersNeedingFulltext,
  setPaperFulltext,
  setPaperPdfUrl,
} from './repo.js';
import { candidatePdfPath, ensureCandidatesDir } from './workspace.js';
import { doiFromExternalId } from '../bibliography/domain/doi.js';
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
 *
 * `resolveMissing` が false のときは、収集時に取れた直リンクだけを使う。
 * 1 件ずつ書誌 LLM に引き直すのは mypaper 採点で本文が要るときに限る。
 */
export async function ensureCandidateFulltexts(
  db: Db,
  projectId: string,
  root: string,
  deps: CandidatePdfDeps,
  opts: { limit?: number; signal?: AbortSignal; resolveMissing?: boolean } = {},
): Promise<CandidatePdfResult> {
  ensureCandidatesDir(root);
  const papers = listPapersNeedingFulltext(db, projectId, opts.limit ?? 200);
  const result: CandidatePdfResult = { attempted: 0, extracted: 0, downloaded: 0, failed: 0 };
  const resolveMissing = opts.resolveMissing !== false;

  for (const p of papers) {
    if (opts.signal?.aborted) break;
    result.attempted++;

    const dest = candidatePdfPath(root, p.paper_id);
    let path = p.fulltext_path && existsSync(p.fulltext_path) ? p.fulltext_path : null;
    if (!path && existsSync(dest)) path = dest;

    if (!path) {
      const url = resolveMissing
        ? await resolvePdfUrl(db, p, deps)
        : knownPdfUrl(p);
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

const FIRST_PAGE_MAX = 4000;

/**
 * 著者が空の候補について、手元の PDF（なければ OA）の 1 ページ目を LLM に読ませる。
 * 公開書誌の穴埋め（ADR-0002 C1）。採点用の全文は載せない。
 */
export async function fillMissingPaperAuthors(
  db: Db,
  projectId: string,
  root: string,
  deps: CandidatePdfDeps,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<{ attempted: number; filled: number }> {
  ensureCandidatesDir(root);
  const papers = listPapersMissingAuthors(db, projectId, opts.limit ?? 40);
  let attempted = 0;
  let filled = 0;

  for (const p of papers) {
    if (opts.signal?.aborted) break;
    attempted++;

    const dest = candidatePdfPath(root, p.paper_id);
    let path = p.fulltext_path && existsSync(p.fulltext_path) ? p.fulltext_path : null;
    if (!path && existsSync(dest)) path = dest;

    let page: string | null = null;
    let infoAuthors: string | null = null;
    if (path) {
      const extracted = await firstPageFromFile(path);
      page = extracted.page;
      infoAuthors = extracted.authors;
    }
    if (!page && p.fulltext?.trim()) page = p.fulltext.trim().slice(0, FIRST_PAGE_MAX);

    if (!page) {
      const url = await resolvePdfUrl(db, p, deps);
      if (!url) continue;
      const dl = await deps.pdfs.download(url, dest);
      if (dl !== 'ok' && dl !== 'exists') continue;
      const extracted = await firstPageFromFile(dest);
      page = extracted.page;
      infoAuthors = extracted.authors;
    }

    if (!page) {
      if (infoAuthors && fillPaperAuthors(db, p.paper_id, infoAuthors)) filled++;
      continue;
    }

    try {
      const doi = doiFromExternalId(p.external_id);
      const got = await deps.gateway.complete({
        title: p.title.trim() || undefined,
        doi: doi ?? undefined,
        url: p.url ?? undefined,
        authors: infoAuthors ?? undefined,
        first_page: page,
      });
      const names = got?.record?.authors?.trim() || infoAuthors;
      if (names && fillPaperAuthors(db, p.paper_id, names)) filled++;
    } catch {
      if (infoAuthors && fillPaperAuthors(db, p.paper_id, infoAuthors)) filled++;
    }
  }

  return { attempted, filled };
}

async function firstPageFromFile(path: string): Promise<{ page: string | null; authors: string | null }> {
  try {
    const meta = await extractFromPdf(new Uint8Array(readFileSync(path)));
    return {
      page: meta.firstPageText?.trim() ? meta.firstPageText.trim().slice(0, FIRST_PAGE_MAX) : null,
      authors: meta.authors?.trim() || null,
    };
  } catch {
    return { page: null, authors: null };
  }
}

/** 収集時に来た直リンクだけ。LLM にも OpenAlex にも引き直さない */
function knownPdfUrl(p: { url: string | null; pdf_url: string | null }): string | null {
  const cached = httpsPdfUrl(p.pdf_url);
  if (cached) return cached;
  const fromUrl = httpsPdfUrl(p.url);
  return fromUrl && /\.pdf(?:[?#]|$)/i.test(fromUrl) ? fromUrl : null;
}

async function resolvePdfUrl(
  db: Db,
  p: { paper_id: string; title: string; url: string | null; external_id: string | null; pdf_url: string | null },
  deps: CandidatePdfDeps,
): Promise<string | null> {
  const known = knownPdfUrl(p);
  if (known) return known;

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
