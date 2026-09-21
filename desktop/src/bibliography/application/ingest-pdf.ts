import { followReference } from './follow-reference.js';
import type { BibliographyDeps } from './ports.js';

export async function ingestPdf(
  deps: BibliographyDeps,
  projectId: string,
  filePath: string,
  bytes: Uint8Array,
): Promise<{ reference_id: string; existing: boolean; guessed: boolean }> {
  const path = deps.paths.resolve(filePath);
  const attached = deps.refs.findByPath(path);
  if (attached) {
    await followReference(deps, projectId, attached.reference_id);
    return { reference_id: attached.reference_id, existing: true, guessed: false };
  }

  const meta = await deps.extract.fromBytes(bytes);
  const title = meta.title ?? deps.paths.basename(path).replace(/\.pdf$/i, '');
  const guessed = meta.titleSource !== 'info';
  if (meta.doi) {
    const existing = deps.refs.findByDoi(projectId, meta.doi);
    if (existing) {
      deps.refs.addAttachment(existing, path);
      await followReference(deps, projectId, existing);
      return { reference_id: existing, existing: true, guessed };
    }
  }

  const refId = deps.refs.add(projectId, {
    title,
    authors: meta.authors,
    year: meta.year,
    doi: meta.doi,
  });
  deps.refs.addAttachment(refId, path);
  await followReference(deps, projectId, refId);
  return { reference_id: refId, existing: false, guessed };
}
