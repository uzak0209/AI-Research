// PDF から書誌を取り出す。
//
// 方針:
//   - **まずローカルだけで取れるところまで取る。** PDF の Info 辞書と 1 ページ目の本文
//   - オンライン照会（DOI → 書誌）は**別の関数に分け、呼び出し側が明示的に選ぶ**。
//     DOI を外部 API に送ると「何を読んでいるか」が外に出るため、既定では行わない（C-03）
//   - 取れなかった項目は**推測で埋めない**。null のまま返して UI に出す（C-07）

export interface ExtractedMeta {
  title: string | null;
  authors: string | null;
  year: number | null;
  doi: string | null;
  /** 何をどこから取ったか。UI で「推測」と「PDF に書いてあった」を区別するため */
  sources: {
    title: 'info' | 'text' | null;
    authors: 'info' | null;
    year: 'info' | 'text' | null;
    doi: 'text' | null;
  };
  pageCount: number;
  /** 本文が取れなかった（画像だけの PDF 等）場合に true */
  textEmpty: boolean;
}

const DOI_RE = /10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/;

/** PDF の CreationDate は `D:YYYYMMDD...` の形 */
function yearFromPdfDate(d: unknown): number | null {
  if (typeof d !== 'string') return null;
  const m = d.match(/^D:(\d{4})/);
  if (!m) return null;
  const y = Number(m[1]);
  return y >= 1800 && y <= 2200 ? y : null;
}

/** 日本語・中国語・韓国語の文字。ここに空白を挟むと語が壊れる */
const CJK = /[　-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;

/**
 * PDF の文字断片をつなぐ。
 *
 * pdf.js は 1 行を複数の断片に分けて返すことがある。
 * 断片の間に無条件で空白を入れると**日本語が「麻雀 A I の開発」のように割れる**ため、
 * 両隣が CJK のときは空白を入れない。欧文は語の区切りが必要なので入れる。
 */
export function appendPiece(acc: string, piece: string): string {
  if (!piece) return acc;
  if (!acc) return piece;

  const left = acc.at(-1) ?? '';
  const right = piece[0] ?? '';

  // 既にどちらかが空白ならそのままつなぐ
  if (/\s/.test(left) || /\s/.test(right)) return acc + piece;
  // 片方でも CJK なら空白を入れない
  if (CJK.test(left) || CJK.test(right)) return acc + piece;

  return acc + ' ' + piece;
}

function cleanup(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 0 ? t : null;
}

/**
 * 1 ページ目の本文から表題らしい行を拾う。
 * PDF の Info に Title が無いときの控え。**当てずっぽうなので sources に 'text' と残す。**
 */
function guessTitleFromText(lines: string[]): string | null {
  for (const raw of lines.slice(0, 12)) {
    const l = raw.trim();
    // 短すぎ・長すぎ・URL・ページ番号は表題ではない
    if (l.length < 12 || l.length > 250) continue;
    if (/^https?:\/\//i.test(l) || DOI_RE.test(l)) continue;
    if (/^(abstract|arxiv|preprint|page\s+\d+)\b/i.test(l)) continue;
    if (!/[A-Za-z぀-ヿ一-鿿]/.test(l)) continue;
    return cleanup(l);
  }
  return null;
}

/**
 * PDF からローカルだけで分かる書誌を取り出す。
 * @param data PDF のバイト列
 */
export async function extractFromPdf(data: Uint8Array): Promise<ExtractedMeta> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // destroy() は loadingTask 側にある。doc 側には無い
  const task = pdfjs.getDocument({ data, useSystemFonts: true });
  const doc = await task.promise;

  // 解析中に落ちても loadingTask を放置しない
  const meta: ExtractedMeta = {
    title: null,
    authors: null,
    year: null,
    doi: null,
    sources: { title: null, authors: null, year: null, doi: null },
    pageCount: doc.numPages,
    textEmpty: false,
  };

  try {
    const info = (await doc.getMetadata()).info as Record<string, unknown> | undefined;
    const t = cleanup(info?.Title);
    if (t) {
      meta.title = t;
      meta.sources.title = 'info';
    }
    const a = cleanup(info?.Author);
    if (a) {
      meta.authors = a;
      meta.sources.authors = 'info';
    }
    const y = yearFromPdfDate(info?.CreationDate);
    if (y) {
      meta.year = y;
      meta.sources.year = 'info';
    }
  } catch {
    // Info 辞書が壊れていても本文からの抽出は続ける
  }

  // 1〜2 ページ目の本文。DOI は表紙か脚注にあることが多い
  const lines: string[] = [];
  let joined = '';
  for (let p = 1; p <= Math.min(doc.numPages, 2); p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const items = tc.items as { str?: string; hasEOL?: boolean }[];
    let cur = '';
    for (const it of items) {
      cur = appendPiece(cur, it.str ?? '');
      if (it.hasEOL) {
        lines.push(cur);
        cur = '';
      }
    }
    if (cur.trim()) lines.push(cur);
    joined += lines.slice(-1).join('') + ' ';
  }
  joined = lines.join(' ');

  meta.textEmpty = joined.trim().length === 0;

  const doi = joined.match(DOI_RE);
  if (doi) {
    // 末尾の句読点は DOI ではない
    meta.doi = doi[0].replace(/[.,;)]+$/, '');
    meta.sources.doi = 'text';
  }

  if (!meta.title) {
    const guess = guessTitleFromText(lines);
    if (guess) {
      meta.title = guess;
      meta.sources.title = 'text';
    }
  }

  if (!meta.year) {
    const y = joined.match(/\b(19|20)\d{2}\b/);
    if (y) {
      meta.year = Number(y[0]);
      meta.sources.year = 'text';
    }
  }

  await task.destroy();
  return meta;
}

// --- オンライン照会（明示的に呼ぶ） --------------------------------------------

export interface LookupResult {
  title: string | null;
  authors: string | null;
  year: number | null;
  venue: string | null;
  abstract: string | null;
}

/**
 * DOI から書誌を引く。**DOI を外部 API に送る。**
 * 何を読んでいるかが相手に伝わるので、利用者が明示的に選んだときだけ呼ぶこと。
 *
 * @throws 取得できなかったときは投げる。空の結果を「見つからなかった」と偽らない（C-07）
 */
export async function lookupByDoi(doi: string): Promise<LookupResult> {
  const url = `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}`;
  const res = await fetch(url, {
    headers: { 'user-agent': 'ai-research (desktop)' },
  });
  if (!res.ok) throw new Error(`OpenAlex から取得できなかった (status=${res.status})`);

  const w = (await res.json()) as {
    display_name?: string;
    publication_year?: number;
    authorships?: { author?: { display_name?: string } }[];
    primary_location?: { source?: { display_name?: string } };
    abstract_inverted_index?: Record<string, number[]> | null;
  };

  const authors =
    w.authorships
      ?.map((a) => a.author?.display_name)
      .filter(Boolean)
      .join('; ') || null;

  let abstract: string | null = null;
  if (w.abstract_inverted_index) {
    const slots: string[] = [];
    for (const [word, positions] of Object.entries(w.abstract_inverted_index)) {
      for (const p of positions) slots[p] = word;
    }
    abstract = slots.filter(Boolean).join(' ').trim() || null;
  }

  return {
    title: cleanup(w.display_name),
    authors,
    year: w.publication_year ?? null,
    venue: cleanup(w.primary_location?.source?.display_name),
    abstract,
  };
}
