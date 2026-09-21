import { readFileSync } from 'node:fs';
import type { CloudClient } from '@ai-research/core';
import type { Db } from '../shared/db.js';
import { followReference } from './application/follow-reference.js';
import { ingestPdf } from './application/ingest-pdf.js';
import type { BibliographyDeps } from './application/ports.js';
import {
  bffBibliographyGateway,
  fsCiteFiles,
  fsPdfStore,
  nodePaths,
  pdfjsExtractor,
  sqliteReferenceRepo,
} from './infrastructure/adapters.js';

export function createBibliographyApp(db: Db, getClient: () => CloudClient | null): BibliographyDeps & {
  follow(projectId: string, referenceId: string): ReturnType<typeof followReference>;
  ingestFile(projectId: string, filePath: string): ReturnType<typeof ingestPdf>;
} {
  const deps: BibliographyDeps = {
    refs: sqliteReferenceRepo(db),
    gateway: bffBibliographyGateway(getClient),
    pdfs: fsPdfStore(),
    cites: fsCiteFiles(db),
    extract: pdfjsExtractor(),
    paths: nodePaths(),
  };
  return {
    ...deps,
    follow: (projectId, referenceId) => followReference(deps, projectId, referenceId),
    ingestFile: (projectId, filePath) =>
      ingestPdf(deps, projectId, filePath, new Uint8Array(readFileSync(filePath))),
  };
}

export type BibliographyApp = ReturnType<typeof createBibliographyApp>;
