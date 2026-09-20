// PDF からの書誌抽出の検証。
// 重点は「取れなかったものを推測で埋めないこと」（C-07）。

import { describe, expect, it } from 'vitest';
import { appendPiece, extractFromPdf } from '../src/shared/pdf-import.js';

/** 最小の PDF を組み立てる。外部のサンプルファイルに依存しない */
function makePdf(opts: { lines?: string[]; info?: Record<string, string> } = {}): Uint8Array {
  const lines = opts.lines ?? [];
  const content =
    'BT /F1 14 Tf 60 740 Td ' +
    lines.map((l, i) => `${i === 0 ? '' : '0 -24 Td '}(${l.replace(/[()\\]/g, '')}) Tj `).join('') +
    'ET';

  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let trailerInfo = '';
  if (opts.info) {
    const entries = Object.entries(opts.info)
      .map(([k, v]) => `/${k} (${v})`)
      .join(' ');
    objs.push(`<< ${entries} >>`);
    trailerInfo = ` /Info ${objs.length} 0 R`;
  }

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R${trailerInfo} >>\nstartxref\n${xref}\n%%EOF`;

  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

describe('PDF の書誌抽出', () => {
  it('Info 辞書からタイトル・著者・年を取る', async () => {
    const pdf = makePdf({
      lines: ['Some body text here'],
      info: {
        Title: 'Graph Neural Networks for Molecular Property Prediction',
        Author: 'Jane Smith; John Doe',
        CreationDate: 'D:20240615120000Z',
      },
    });

    const m = await extractFromPdf(pdf);
    expect(m.title).toBe('Graph Neural Networks for Molecular Property Prediction');
    expect(m.authors).toBe('Jane Smith; John Doe');
    expect(m.year).toBe(2024);
    // どこから取ったかが分かる
    expect(m.sources).toMatchObject({ title: 'info', authors: 'info', year: 'info' });
    expect(m.pageCount).toBe(1);
  });

  it('本文から DOI を拾う。末尾の句読点は含めない', async () => {
    const pdf = makePdf({ lines: ['Published at https://doi.org/10.1021/acs.jcim.4c01234.'] });
    const m = await extractFromPdf(pdf);
    expect(m.doi).toBe('10.1021/acs.jcim.4c01234');
    expect(m.sources.doi).toBe('text');
  });

  it('DOI が無ければ null。それらしい文字列をでっち上げない', async () => {
    const pdf = makePdf({ lines: ['No identifier in this document at all'] });
    const m = await extractFromPdf(pdf);
    expect(m.doi).toBeNull();
    expect(m.sources.doi).toBeNull();
  });

  it('Info にタイトルが無ければ本文から推測し、推測と分かるようにする', async () => {
    const pdf = makePdf({
      lines: ['Deep Learning Approaches to Protein Folding', 'Introduction', 'text text'],
    });
    const m = await extractFromPdf(pdf);
    expect(m.title).toBe('Deep Learning Approaches to Protein Folding');
    // 'info' ではなく 'text'。UI で「推測」と出せる
    expect(m.sources.title).toBe('text');
  });

  it('表題らしい行が無ければ null。短い行を無理に採らない', async () => {
    const pdf = makePdf({ lines: ['p1', 'ab', '2024'] });
    const m = await extractFromPdf(pdf);
    expect(m.title).toBeNull();
    expect(m.sources.title).toBeNull();
  });

  it('URL や DOI の行は表題にしない', async () => {
    const pdf = makePdf({ lines: ['https://doi.org/10.1000/xyz123456789', 'A Real Title Goes Here'] });
    const m = await extractFromPdf(pdf);
    expect(m.title).toBe('A Real Title Goes Here');
  });

  it('本文が空の PDF はそれと分かる（画像だけの PDF 対策）', async () => {
    const pdf = makePdf({ lines: [] });
    const m = await extractFromPdf(pdf);
    expect(m.textEmpty).toBe(true);
    expect(m.title).toBeNull();
  });

  it('壊れた PDF は例外になる。空の結果を返して成功に見せない', async () => {
    const broken = new Uint8Array(Buffer.from('not a pdf at all', 'latin1'));
    await expect(extractFromPdf(broken)).rejects.toThrow();
  });
});

describe('文字断片のつなぎ方', () => {
  // pdf.js は 1 行を複数の断片で返す。断片の間に無条件で空白を入れると
  // 日本語が「麻 雀 A I の 開 発」のように割れる（実ファイルで確認した不具合）
  it('CJK どうしの間に空白を入れない', () => {
    expect(appendPiece('麻雀', 'AI')).toBe('麻雀AI');
    expect(appendPiece('教師あり学習と', '強化学習')).toBe('教師あり学習と強化学習');
  });

  it('CJK と欧文の境目にも空白を入れない', () => {
    expect(appendPiece('麻雀', 'AI の開発')).toBe('麻雀AI の開発');
    expect(appendPiece('AI', 'の開発')).toBe('AIの開発');
  });

  it('欧文どうしは語が繋がらないよう空白を入れる', () => {
    expect(appendPiece('Graph', 'Neural')).toBe('Graph Neural');
  });

  it('既に空白があれば足さない', () => {
    expect(appendPiece('Graph ', 'Neural')).toBe('Graph Neural');
    expect(appendPiece('Graph', ' Neural')).toBe('Graph Neural');
  });

  it('空の断片は無視する', () => {
    expect(appendPiece('Graph', '')).toBe('Graph');
    expect(appendPiece('', 'Graph')).toBe('Graph');
  });

  it('推測したタイトルの連続空白は 1 つに詰める', async () => {
    const pdf = makePdf({ lines: ['A   Title   With   Wide   Gaps   Here'] });
    const m = await extractFromPdf(pdf);
    expect(m.title).toBe('A Title With Wide Gaps Here');
  });
});
