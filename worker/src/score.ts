/**
 * 粗い採点。**文字列一致の水準に留める**（ADR-0004）。
 * 埋め込みによる精密な採点はローカル（ADR-0001, C-09）
 */
export function coarseScore(summary: string, text: string): number {
  const terms = new Set(
    summary
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 4),
  );
  if (terms.size === 0) return 0;
  const hay = text.toLowerCase();
  let hit = 0;
  for (const t of terms) if (hay.includes(t)) hit++;
  return hit / terms.size;
}
