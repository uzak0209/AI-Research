// PDF から書誌を取り出す。
//
// 方針:
//   - **まずローカルだけで取れるところまで取る。** PDF の Info 辞書と 1 ページ目の本文
//   - オンライン照会は Worker の POST /bff/bibliography（`bibliography/` の gateway）。
//     メインからだけ呼ぶ。クライアントから OpenAlex / Orca を直接叩かない（ADR-0002）
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
  /** 1 ページ目。書誌補完の hint 用。4000 字で切る */
  firstPageText: string | null;
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
    firstPageText: null,
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
  const page1: string[] = [];
  let joined = '';
  for (let p = 1; p <= Math.min(doc.numPages, 2); p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const items = tc.items as { str?: string; hasEOL?: boolean }[];
    let cur = '';
    const pageLines: string[] = [];
    for (const it of items) {
      cur = appendPiece(cur, it.str ?? '');
      if (it.hasEOL) {
        pageLines.push(cur);
        cur = '';
      }
    }
    if (cur.trim()) pageLines.push(cur);
    if (p === 1) page1.push(...pageLines);
    lines.push(...pageLines);
  }
  joined = lines.join(' ');
  const page1text = page1.join(' ').replace(/\s+/g, ' ').trim();
  meta.firstPageText = page1text ? page1text.slice(0, 4000) : null;

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
