import {
  EXPORT_BIB_PATH_KEY,
  EXPORT_FORMAT_KEY,
  NotSignedInError,
  createSettingsStore,
  type CloudClient,
} from '@ai-research/core';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { Db } from '../../shared/db.js';
import { getProject } from '../../shared/repo.js';
import {
  addAttachment,
  addReference,
  findAttachmentByPath,
  findReferenceByDoi,
  getReference,
  listAttachments,
  listReferences,
  updateReference,
} from '../../shared/library.js';
import { extractFromPdf } from '../../shared/pdf-import.js';
import { httpsPdfUrl } from '../domain/oa-url.js';
import { isEmptyRecord, type BibliographicRecord, type BibliographyHint } from '../domain/record.js';
import {
  citeInner,
  citeMarkers,
  planSplice,
  type CiteFormat,
  type CiteItem,
} from '../domain/cite-format.js';
import type {
  BibliographyGateway,
  CiteExportResult,
  CiteFiles,
  Paths,
  PdfExtractor,
  PdfStore,
  ReferenceRepo,
} from '../application/ports.js';

export function sqliteReferenceRepo(db: Db): ReferenceRepo {
  return {
    get(referenceId) {
      const r = getReference(db, referenceId);
      if (!r) return undefined;
      return {
        reference_id: r.reference_id,
        title: r.title,
        authors: r.authors,
        year: r.year,
        doi: r.doi,
        url: r.url,
        venue: r.venue,
        abstract: r.abstract,
        item_type: r.item_type,
        bibtex_key: r.bibtex_key,
      };
    },
    list(projectId) {
      return listReferences(db, projectId).map((r) => ({
        reference_id: r.reference_id,
        title: r.title,
        authors: r.authors,
        year: r.year,
        doi: r.doi,
        url: r.url,
        venue: r.venue,
        abstract: r.abstract,
        item_type: r.item_type,
        bibtex_key: r.bibtex_key,
      }));
    },
    add(projectId, item) {
      return addReference(db, projectId, item);
    },
    update(referenceId, patch) {
      updateReference(db, referenceId, {
        title: patch.title,
        authors: patch.authors,
        year: patch.year,
        doi: patch.doi,
        url: patch.url,
        venue: patch.venue,
        abstract: patch.abstract,
        item_type: patch.item_type,
      });
    },
    addAttachment(referenceId, path) {
      addAttachment(db, referenceId, path);
    },
    attachments(referenceId) {
      return listAttachments(db, referenceId);
    },
    findByDoi(projectId, doi) {
      return findReferenceByDoi(db, projectId, doi);
    },
    findByPath(path) {
      return findAttachmentByPath(db, path);
    },
    projectRoot(projectId) {
      return getProject(db, projectId)?.root_path ?? null;
    },
    paperId(referenceId) {
      return getReference(db, referenceId)?.paper_id ?? null;
    },
    citeItems(projectId): CiteItem[] {
      return listReferences(db, projectId).map((r) => ({
        bibtex_key: r.bibtex_key,
        title: r.title,
        authors: r.authors,
        year: r.year,
        doi: r.doi,
        url: r.url,
        venue: r.venue,
        item_type: r.item_type,
      }));
    },
  };
}

export function bffBibliographyGateway(getClient: () => CloudClient | null): BibliographyGateway {
  return {
    async complete(hint: BibliographyHint) {
      const client = getClient();
      if (!client) return null;
      if (!hint.title?.trim() && !hint.doi?.trim()) throw new Error('タイトルか DOI が要る');

      let res: Response;
      try {
        res = await client.bibliography(hint);
      } catch (e) {
        if (e instanceof NotSignedInError) throw new Error('クラウドに接続していない');
        throw e;
      }
      if (res.status === 401) throw new Error('クラウドに接続していない');
      if (res.status === 429) throw new Error('今日の利用上限に達した');
      if (res.status === 501) throw new Error('書誌補完がクラウド側で閉じている');
      if (!res.ok) {
        let detail = `status=${res.status}`;
        try {
          const body = (await res.json()) as { detail?: string };
          if (typeof body.detail === 'string' && body.detail) detail = body.detail;
        } catch {
          // status で足りる
        }
        throw new Error(`書誌を取れなかった (${detail})`);
      }
      const body = (await res.json()) as { record?: BibliographicRecord; pdf_url?: string | null };
      const pdf_url = httpsPdfUrl(body.pdf_url ?? null);
      const record = isEmptyRecord(body.record) ? null : body.record!;
      // 著者無しは成功にしない（C-07）。ただし OA の直 PDF は後で 1 ページ目を読ませるために残す
      if (!record && !pdf_url) throw new Error('書誌を補れなかった');
      return { record, pdf_url };
    },
  };
}

const MAX_BYTES = 40 * 1024 * 1024;
const PDF_MAGIC = Buffer.from('%PDF');

export function fsPdfStore(written: Set<string> = new Set()): PdfStore {
  return {
    async download(url, dest) {
      if (!httpsPdfUrl(url)) return 'failed';
      if (existsSync(dest)) return 'exists';
      let res: Response;
      try {
        res = await fetch(url, { redirect: 'follow', headers: { accept: 'application/pdf,*/*' } });
      } catch {
        return 'failed';
      }
      if (!res.ok) return 'failed';
      const len = Number(res.headers.get('content-length') ?? '0');
      if (len > MAX_BYTES) return 'failed';
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) return 'failed';
      if (buf.subarray(0, 4).compare(PDF_MAGIC) !== 0) return 'not_pdf';
      await mkdir(dirname(dest), { recursive: true });
      if (existsSync(dest)) return 'exists';
      await writeFile(dest, buf);
      return 'ok';
    },
    rememberWrite(path) {
      written.add(resolve(path));
    },
    wasWritten(path) {
      return written.has(resolve(path));
    },
  };
}

function guessCiteTarget(root: string): { path: string; format: CiteFormat } | null {
  const dir = join(root, 'mypaper');
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir);
  const bibs = names.filter((n) => extname(n).toLowerCase() === '.bib');
  const ymls = names.filter((n) => {
    const e = extname(n).toLowerCase();
    return e === '.yml' || e === '.yaml';
  });
  if (bibs.length === 1 && ymls.length === 0) return { path: join(dir, bibs[0]!), format: 'bibtex' };
  if (ymls.length === 1 && bibs.length === 0) return { path: join(dir, ymls[0]!), format: 'hayagriva' };
  return null;
}

function getCiteExportHash(db: Db, path: string): string | null {
  const row = db.prepare('SELECT inner_hash FROM cite_exports WHERE path = ?').get(path) as
    | { inner_hash: string }
    | undefined;
  return row?.inner_hash ?? null;
}

function setCiteExportHash(db: Db, path: string, hash: string): void {
  db.prepare(
    `INSERT INTO cite_exports (path, inner_hash, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(path) DO UPDATE SET inner_hash = excluded.inner_hash, updated_at = excluded.updated_at`,
  ).run(path, hash);
}

export function fsCiteFiles(db: Db): CiteFiles {
  return {
    exportAll(projectId, items): CiteExportResult {
      const project = getProject(db, projectId);
      const settings = createSettingsStore(db);
      const bibPath = settings.get(EXPORT_BIB_PATH_KEY)?.value ?? null;
      const formatSet = settings.get(EXPORT_FORMAT_KEY)?.value ?? null;
      let target: { path: string; format: CiteFormat } | null = null;
      if (bibPath && existsSync(bibPath)) {
        target = { path: bibPath, format: formatSet === 'hayagriva' ? 'hayagriva' : 'bibtex' };
      } else if (project?.root_path) {
        target = guessCiteTarget(project.root_path);
      }
      if (!target || !existsSync(target.path)) return 'skipped';
      const format: CiteFormat =
        target.format === 'hayagriva' || extname(target.path).toLowerCase() !== '.bib' ? target.format : 'bibtex';
      const { begin, end } = citeMarkers(format);
      const inner = citeInner(items, format);
      const source = readFileSync(target.path, 'utf8');
      const key = resolve(target.path);
      const plan = planSplice(source, inner, begin, end, getCiteExportHash(db, key));
      if (plan.status === 'skip_removed' || plan.status === 'skip_broken') return 'skipped';
      if (plan.status === 'skip_conflict') return 'conflict';
      writeFileSync(target.path, plan.next);
      setCiteExportHash(db, key, plan.hash);
      return 'ok';
    },
  };
}

export function pdfjsExtractor(): PdfExtractor {
  return {
    async fromBytes(data) {
      const meta = await extractFromPdf(data);
      return {
        title: meta.title,
        authors: meta.authors,
        year: meta.year,
        doi: meta.doi,
        firstPageText: meta.firstPageText,
        titleSource: meta.sources.title,
      };
    },
    async firstPageFromPath(path) {
      try {
        const meta = await extractFromPdf(new Uint8Array(readFileSync(path)));
        return meta.firstPageText;
      } catch {
        return null;
      }
    },
  };
}

export function nodePaths(): Paths {
  return {
    resolve: (p) => resolve(p),
    basename: (p) => basename(p),
    isPdf: (p) => extname(p).toLowerCase() === '.pdf',
    oaDest: (root, key) => join(root, 'references', `${key}.pdf`),
  };
}
