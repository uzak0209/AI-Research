import { normalizeDoi } from '../domain/doi';
import { recordFromModelText, type BibliographyHint, type BibliographyRecord } from '../domain/record';
import type { BibliographyDeps } from './ports';

export type BibliographyOk = {
  ok: true;
  record: BibliographyRecord;
  pdf_url: string | null;
  model: string | null;
  requestedModel: string | null;
  tokens: number;
  costUsd: number | null;
  latencyMs: number;
  fallbackUsed: boolean;
};
export type BibliographyFail = { ok: false; status: number; detail: string };

export async function completeBibliography(
  deps: BibliographyDeps,
  hint: BibliographyHint,
): Promise<BibliographyOk | BibliographyFail> {
  const got = await deps.llm.complete(hint);
  if (!got.ok) return { ok: false, status: 502, detail: 'orcarouter' };

  const record = recordFromModelText(got.text);
  const doi = record.doi ?? normalizeDoi(hint.doi);
  let pdf_url: string | null = null;
  if (doi) {
    try {
      pdf_url = await deps.oaPdf.pdfUrl(doi);
    } catch {
      pdf_url = null;
    }
  }
  return {
    ok: true,
    record,
    pdf_url,
    model: got.model,
    requestedModel: got.requestedModel,
    tokens: got.tokens,
    costUsd: got.costUsd,
    latencyMs: got.latencyMs,
    fallbackUsed: got.fallbackUsed,
  };
}
