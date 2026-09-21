import type { BibliographyHint } from '../domain/record';
import type { OaBiblio } from '../domain/oa-url';

export type LlmJson =
  | {
      ok: true;
      text: string;
      model: string;
      requestedModel: string;
      tokens: number;
      costUsd: number | null;
      latencyMs: number;
      fallbackUsed: boolean;
    }
  | { ok: false };

export interface BibliographyLlm {
  complete(hint: BibliographyHint): Promise<LlmJson>;
}

export interface OaPdfLookup {
  /** DOI 一致の 1 件。検索して同一論文かを切らない（ADR-0002） */
  lookup(doi: string): Promise<OaBiblio | null>;
}

export type BibliographyDeps = {
  llm: BibliographyLlm;
  oaPdf: OaPdfLookup;
};
