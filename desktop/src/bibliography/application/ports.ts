import type { BibliographicRecord, BibliographyHint, ReferenceSnapshot } from '../domain/record.js';
import type { CiteItem } from '../domain/cite-format.js';

export type PdfDownload = 'ok' | 'exists' | 'not_pdf' | 'failed';

export type ExtractedPdf = {
  title: string | null;
  authors: string | null;
  year: number | null;
  doi: string | null;
  firstPageText: string | null;
  /** Info 辞書なら推測ではない。本文・ファイル名は guessed */
  titleSource: 'info' | 'text' | null;
};

export interface ReferenceRepo {
  get(referenceId: string): ReferenceSnapshot | undefined;
  list(projectId: string): ReferenceSnapshot[];
  add(
    projectId: string,
    item: {
      title: string;
      authors?: string | null;
      year?: number | null;
      doi?: string | null;
    },
  ): string;
  update(referenceId: string, patch: Partial<ReferenceSnapshot>): void;
  addAttachment(referenceId: string, path: string): void;
  attachments(referenceId: string): { path: string }[];
  findByDoi(projectId: string, doi: string): string | undefined;
  findByPath(path: string): { reference_id: string } | undefined;
  projectRoot(projectId: string): string | null;
  /** 候補から保存したときの papers.paper_id。無ければ null */
  paperId(referenceId: string): string | null;
  citeItems(projectId: string): CiteItem[];
}

export interface BibliographyGateway {
  /** 未ログインなら null。失敗は throw */
  complete(hint: BibliographyHint): Promise<{ record: BibliographicRecord; pdf_url: string | null } | null>;
}

export interface PdfStore {
  download(url: string, dest: string): Promise<PdfDownload>;
  rememberWrite(path: string): void;
  wasWritten(path: string): boolean;
}

export interface CiteFiles {
  exportAll(projectId: string, items: CiteItem[]): void;
}

export interface PdfExtractor {
  fromBytes(data: Uint8Array): Promise<ExtractedPdf>;
  firstPageFromPath(path: string): Promise<string | null>;
}

export interface Paths {
  resolve(path: string): string;
  basename(path: string): string;
  isPdf(path: string): boolean;
  oaDest(root: string, bibtexKey: string): string;
}

export type BibliographyDeps = {
  refs: ReferenceRepo;
  gateway: BibliographyGateway;
  pdfs: PdfStore;
  cites: CiteFiles;
  extract: PdfExtractor;
  paths: Paths;
};
