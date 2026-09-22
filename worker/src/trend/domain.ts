import type { FetchedPaper } from '../shared/papers/domain';

export const TREND_PAPER_LIMIT = 12;
const ABSTRACT_CHARS = 400;
export const THEME_LIMIT = 5;

export type TrendPaper = {
  title: string;
  url: string | null;
  published_at: string | null;
};

export type TrendReport = {
  trend: string | null;
  themes: string[];
};

/**
 * 公開論文の題・要旨・URL・日付だけを載せる。
 * 原稿や手元データは渡さない（C-01, C-09）。
 */
export function trendPrompt(topic: string, papers: FetchedPaper[]): string {
  const listed = papers.slice(0, TREND_PAPER_LIMIT).map((p, i) => {
    const abs = (p.abstract ?? '').slice(0, ABSTRACT_CHARS);
    const when = p.published_at ?? 'n.d.';
    const url = p.url ?? '';
    return `${i + 1}. ${p.title} (${when}) ${url}\n${abs}`.trim();
  });
  return [
    `Topic: ${topic}`,
    'Using ONLY the public papers below, write a JSON object with:',
    '- "trend": 2-6 sentences on the current research trend in this set. Same language as the topic. If the list is thin, say so.',
    `- "themes": 3 to ${THEME_LIMIT} next research theme candidates (short noun phrases) grounded in these papers and the topic. Not paper titles.`,
    'Do not invent papers, citations, or results that are not in the list.',
    'Reply with JSON only. No markdown fence.',
    listed.join('\n\n'),
  ].join('\n\n');
}

export function toTrendPapers(papers: FetchedPaper[]): TrendPaper[] {
  return papers.slice(0, TREND_PAPER_LIMIT).map((p) => ({
    title: p.title,
    url: p.url,
    published_at: p.published_at,
  }));
}

export function parseThemesJson(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      if (typeof item !== 'string') continue;
      const t = item.trim();
      if (!t) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
      if (out.length >= THEME_LIMIT) break;
    }
    return out;
  } catch {
    return [];
  }
}

function unescapeJsonString(raw: string): string | null {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    // 末尾が切れて \ や \u が欠けた分だけ落とす
    const safe = raw.replace(/\\u[0-9a-fA-F]{0,3}$/, '').replace(/\\$/, '');
    try {
      return JSON.parse(`"${safe}"`) as string;
    } catch {
      return null;
    }
  }
}

/**
 * 出力が途中で切れた JSON から拾えるだけ拾う。
 * `{"trend": "…` を本文として画面に出さないための最後の砦（C-07）。
 */
function salvageTruncatedJson(body: string): TrendReport {
  const trendMatch = body.match(/"trend"\s*:\s*"((?:[^"\\]|\\.)*)/);
  const trend = trendMatch ? unescapeJsonString(trendMatch[1] ?? '')?.trim() || null : null;

  const themesMatch = body.match(/"themes"\s*:\s*\[([\s\S]*?)(?:\]|$)/);
  const themes: string[] = [];
  if (themesMatch?.[1]) {
    for (const m of themesMatch[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
      const t = unescapeJsonString(m[1] ?? '')?.trim();
      if (!t) continue;
      if (themes.some((x) => x.toLowerCase() === t.toLowerCase())) continue;
      themes.push(t);
      if (themes.length >= THEME_LIMIT) break;
    }
  }
  return { trend, themes };
}

/** JSON のつもりで返ってきたか。地の文と壊れた JSON を分ける */
function looksLikeJsonObject(body: string): boolean {
  return body.startsWith('{') && /"(trend|summary|themes)"\s*:/.test(body);
}

/** モデル出力をトレンド本文と次テーマに分ける。JSON でなければ本文だけ */
export function parseTrendReport(text: string): TrendReport {
  const trimmed = text.trim();
  if (!trimmed) return { trend: null, themes: [] };
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced?.[1] ?? trimmed).trim();
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { trend: trimmed, themes: [] };
    }
    const o = parsed as { trend?: unknown; themes?: unknown; summary?: unknown };
    const trendRaw = typeof o.trend === 'string' ? o.trend : typeof o.summary === 'string' ? o.summary : '';
    const trend = trendRaw.trim() || null;
    const themes = Array.isArray(o.themes)
      ? o.themes
          .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
          .map((t) => t.trim())
          .filter((t, i, arr) => arr.findIndex((x) => x.toLowerCase() === t.toLowerCase()) === i)
          .slice(0, THEME_LIMIT)
      : [];
    if (!trend && themes.length === 0) return { trend: trimmed, themes: [] };
    return { trend, themes };
  } catch {
    // 出力が長さ上限で切れた JSON。生の波括弧を本文として見せない
    if (looksLikeJsonObject(body)) return salvageTruncatedJson(body);
    return { trend: trimmed, themes: [] };
  }
}
