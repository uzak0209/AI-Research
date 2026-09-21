import { hintFromReference, mergeRecord } from '../domain/record.js';
import { httpsPdfUrl } from '../domain/oa-url.js';
import type { BibliographyDeps, PdfDownload } from './ports.js';

export async function followReference(
  deps: BibliographyDeps,
  projectId: string,
  referenceId: string,
): Promise<{ pdf: PdfDownload | 'skipped' }> {
  const row = deps.refs.get(referenceId);
  if (!row) return { pdf: 'skipped' };

  let pdfUrl: string | null = null;
  if (row.title.trim() || row.doi) {
    try {
      const page = await firstPage(deps, referenceId);
      const got = await deps.gateway.complete(
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
      if (got) {
        deps.refs.update(referenceId, mergeRecord(row, got.record));
        pdfUrl = httpsPdfUrl(got.pdf_url);
      }
    } catch {
      // 書誌失敗で文献行は消さない。未補完のまま残す（C-07）
    }
  }

  const attachments = deps.refs.attachments(referenceId);
  const latest = deps.refs.get(referenceId);
  const root = deps.refs.projectRoot(projectId);
  let pdf: PdfDownload | 'skipped' = 'skipped';
  if (attachments.length === 0 && pdfUrl && latest && root) {
    const dest = deps.paths.oaDest(root, latest.bibtex_key);
    deps.pdfs.rememberWrite(dest);
    pdf = await deps.pdfs.download(pdfUrl, dest);
    if (pdf === 'ok' || pdf === 'exists') deps.refs.addAttachment(referenceId, dest);
  }

  deps.cites.exportAll(projectId, deps.refs.citeItems(projectId));
  return { pdf };
}

async function firstPage(deps: BibliographyDeps, referenceId: string): Promise<string | null> {
  const at = deps.refs.attachments(referenceId)[0];
  if (!at) return null;
  return deps.extract.firstPageFromPath(at.path);
}
