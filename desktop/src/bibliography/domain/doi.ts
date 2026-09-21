/** 正規化した DOI。形を成さなければ null（C-07） */
export function normalizeDoi(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = raw.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim();
  return /^10\.\d{4,}/.test(d) ? d : null;
}

export function doiFromExternalId(id: string | null | undefined): string | null {
  return normalizeDoi(id);
}
