import { copyFileSync, existsSync } from 'node:fs';
import { hintFromReference, mergeRecord, type ReferenceSnapshot } from '../domain/record.js';
import { httpsPdfUrl } from '../domain/oa-url.js';
import type { BibliographyDeps, PdfDownload } from './ports.js';
import { candidatePdfPath } from '../../shared/workspace.js';

export async function followReference(
  deps: BibliographyDeps,
  projectId: string,
  referenceId: string,
): Promise<{ pdf: PdfDownload | 'skipped' }> {
  const row = deps.refs.get(referenceId);
  if (!row) return { pdf: 'skipped' };

  const initialPage = await firstPage(deps, projectId, referenceId);
  let pdfUrl: string | null = null;
  if (row.title.trim() || row.doi) {
    const got = await completeFrom(deps, row, initialPage);
    if (got?.record) deps.refs.update(referenceId, mergeRecord(row, got.record));
    pdfUrl = httpsPdfUrl(got?.pdf_url);
  }

  const attachments = deps.refs.attachments(referenceId);
  const latest = deps.refs.get(referenceId);
  const root = deps.refs.projectRoot(projectId);
  let pdf: PdfDownload | 'skipped' = 'skipped';
  if (attachments.length === 0 && latest && root) {
    const dest = deps.paths.oaDest(root, latest.bibtex_key);

    // 採点用 candidates/ にあれば取り直さない（ADR-0003）
    const paperId = deps.refs.paperId(referenceId);
    const promoted = paperId ? copyCandidatePdf(root, paperId, dest) : null;
    if (promoted) {
      deps.refs.addAttachment(referenceId, promoted);
      pdf = 'exists';
    } else if (pdfUrl) {
      deps.pdfs.rememberWrite(dest);
      pdf = await deps.pdfs.download(pdfUrl, dest);
      if (pdf === 'ok' || pdf === 'exists') deps.refs.addAttachment(referenceId, dest);
    }
  }

  // 最初は PDF が無くて著者を取れなかった。手元に来てから 1 ページ目を読ませる
  if (!initialPage) {
    const page = await firstPage(deps, projectId, referenceId);
    const current = deps.refs.get(referenceId);
    if (page && current && (current.title.trim() || current.doi)) {
      const got = await completeFrom(deps, current, page);
      if (got?.record) deps.refs.update(referenceId, mergeRecord(current, got.record));
    }
  }

  deps.cites.exportAll(projectId, deps.refs.citeItems(projectId));
  return { pdf };
}

async function completeFrom(
  deps: BibliographyDeps,
  row: ReferenceSnapshot,
  page: string | null,
) {
  try {
    return await deps.gateway.complete(
      hintFromReference({
        title: row.title,
        authors: row.authors,
        year: row.year,
        doi: row.doi,
        url: row.url,
        venue: row.venue,
        abstract: row.abstract,
        first_page: page,
      }),
    );
  } catch {
    // 書誌失敗で文献行は消さない。未補完のまま残す（C-07）
    return null;
  }
}

function copyCandidatePdf(root: string, paperId: string, dest: string): string | null {
  const src = candidatePdfPath(root, paperId);
  if (!existsSync(src)) return null;
  if (existsSync(dest)) return dest;
  copyFileSync(src, dest);
  return dest;
}

async function firstPage(
  deps: BibliographyDeps,
  projectId: string,
  referenceId: string,
): Promise<string | null> {
  const at = deps.refs.attachments(referenceId)[0];
  if (at) {
    const text = await deps.extract.firstPageFromPath(at.path);
    if (text?.trim()) return text;
  }
  const paperId = deps.refs.paperId(referenceId);
  const root = deps.refs.projectRoot(projectId);
  if (!paperId || !root) return null;
  const src = candidatePdfPath(root, paperId);
  if (!existsSync(src)) return null;
  const text = await deps.extract.firstPageFromPath(src);
  return text?.trim() ? text : null;
}
