import { completeBibliography } from './application/complete';
import type { BibliographyDeps } from './application/ports';
import type { BibliographyHint } from './domain/record';
import { openAlexOaPdf, orcaBibliographyLlm } from './infrastructure/adapters';

export const BIBLIOGRAPHY_ENDPOINT = '/bff/bibliography';

export function createBibliographyApp(opts: { orcaKey: string; openAlexKey?: string }): BibliographyDeps & {
  complete(hint: BibliographyHint): ReturnType<typeof completeBibliography>;
} {
  const deps: BibliographyDeps = {
    llm: orcaBibliographyLlm(opts.orcaKey),
    oaPdf: openAlexOaPdf(opts.openAlexKey),
  };
  return {
    ...deps,
    complete: (hint) => completeBibliography(deps, hint),
  };
}

export type BibliographyApp = ReturnType<typeof createBibliographyApp>;
