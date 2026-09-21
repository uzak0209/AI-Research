import type { BibliographyHint } from '../domain/record';

export type LlmJson = { ok: true; text: string; model: string; tokens: number } | { ok: false };

export interface BibliographyLlm {
  complete(hint: BibliographyHint): Promise<LlmJson>;
}

export interface OaPdfLookup {
  pdfUrl(doi: string): Promise<string | null>;
}

export type BibliographyDeps = {
  llm: BibliographyLlm;
  oaPdf: OaPdfLookup;
};
