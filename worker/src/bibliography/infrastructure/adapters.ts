import { z } from 'zod';
import { chatCompletion } from '../../shared/orca/chat';
import { ORCA_POLICY } from '../../shared/orca/policy';
import { bibliographyPrompt, type BibliographyHint } from '../domain/record';
import { oaBiblioFromWork } from '../domain/oa-url';
import { normalizeDoi } from '../domain/doi';
import type { BibliographyLlm, OaPdfLookup } from '../application/ports';

const resultsSchema = z.object({ results: z.array(z.unknown()).optional() });

export function openAlexPdfUrl(doi: string, opts: { apiKey?: string } = {}): URL {
  const url = new URL('https://api.openalex.org/works');
  url.searchParams.set('filter', `doi:${normalizeDoi(doi) ?? doi}`);
  url.searchParams.set('per-page', '1');
  url.searchParams.set('select', 'doi,best_oa_location,primary_location,open_access');
  if (opts.apiKey) url.searchParams.set('api_key', opts.apiKey);
  return url;
}

export function orcaBibliographyLlm(apiKey: string): BibliographyLlm {
  return {
    async complete(hint: BibliographyHint) {
      const got = await chatCompletion(
        apiKey,
        [
          {
            role: 'system',
            content:
              'You complete public bibliographic records. Published works always have authors; never return authors as null if you identified the work. authors is a "; "-separated string, not an array. Never invent a DOI. If you cannot identify the work, all fields are null.',
          },
          { role: 'user', content: bibliographyPrompt(hint) },
        ],
        ORCA_POLICY.C1,
        true,
      );
      if (!got.ok) return { ok: false };
      return {
        ok: true,
        text: got.text,
        model: got.model,
        requestedModel: got.requestedModel,
        tokens: got.tokens,
        costUsd: got.costUsd,
        latencyMs: got.latencyMs,
        fallbackUsed: got.fallbackUsed,
      };
    },
  };
}

export function openAlexOaPdf(apiKey?: string): OaPdfLookup {
  return {
    async lookup(doi) {
      const res = await fetch(openAlexPdfUrl(doi, { apiKey }), { headers: { accept: 'application/json' } });
      if (!res.ok) return null;
      const parsed = resultsSchema.safeParse(await res.json());
      if (!parsed.success) return null;
      const first = parsed.data.results?.[0];
      return first ? oaBiblioFromWork(first) : null;
    },
  };
}
