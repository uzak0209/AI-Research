/** https の直 PDF だけ。HTML ランディングと http は捨てる（ADR-0003） */
export function httpsPdfUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const u = raw.trim();
  if (!/^https:\/\//i.test(u)) return null;
  if (/\.html?(?:[?#]|$)/i.test(u)) return null;
  if (u.length > 2000) return null;
  return u;
}
