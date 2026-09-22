// 作業フォルダ mypaper/ から読む順の正本を拾う（ADR-0001）。
// 原稿（md/tex/typ）はクラウドへ出さない（C-01）。
// PDF を置いたときは書誌を作り、採点材料にもする。

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { chunkText } from './text-chunk.js';
import { extractFullTextFromPdf } from './pdf-import.js';

const MANUSCRIPT_EXTS = new Set(['.md', '.tex', '.typ']);
const PAPER_EXTS = new Set(['.md', '.tex', '.typ', '.pdf']);

export type MypaperEntry = {
  path: string;
  name: string;
  ext: string;
  kind: 'manuscript' | 'pdf';
  bytes: number;
  mtime: string;
};

/** 実質の原稿または自分の論文 PDF があるか。空ファイルは無い扱い */
export function mypaperHasContent(root: string | null | undefined): boolean {
  return listMypaperEntries(root).some((e) => e.bytes > 0);
}

export function listMypaperEntries(root: string | null | undefined): MypaperEntry[] {
  if (!root) return [];
  const dir = join(root, 'mypaper');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const out: MypaperEntry[] = [];
  const walk = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const p = join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(p);
        continue;
      }
      const ext = extname(name).toLowerCase();
      if (!st.isFile() || !PAPER_EXTS.has(ext)) continue;
      out.push({
        path: p,
        name,
        ext,
        kind: ext === '.pdf' ? 'pdf' : 'manuscript',
        bytes: st.size,
        mtime: new Date(st.mtimeMs).toISOString(),
      });
    }
  };
  walk(dir);
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** mypaper/ 配下の .md / .tex / .typ をチャンク化して返す */
export function loadMypaperChunks(root: string | null | undefined): string[] {
  const chunks: string[] = [];
  for (const f of listMypaperEntries(root).filter((e) => e.kind === 'manuscript')) {
    let body: string;
    try {
      body = readFileSync(f.path, 'utf8');
    } catch {
      continue;
    }
    chunks.push(...chunkText(body));
  }
  return chunks;
}

/** 採点用。原稿テキスト＋自分の論文 PDF 本文。クラウドへは出さない */
export async function loadMypaperScoringTexts(root: string | null | undefined): Promise<string[]> {
  const chunks = loadMypaperChunks(root);
  for (const f of listMypaperEntries(root).filter((e) => e.kind === 'pdf' && e.bytes > 0)) {
    try {
      const text = await extractFullTextFromPdf(new Uint8Array(readFileSync(f.path)));
      if (text) chunks.push(...chunkText(text));
    } catch {
      // 画像 PDF などは採点材料にしない（C-07）
    }
  }
  return chunks;
}

/**
 * ファイルを mypaper/ にコピーする。原本は動かさない。既存は上書きしない（C-08）。
 */
export function copyIntoMypaper(root: string, srcPath: string): { path: string; existed: boolean } {
  const dir = join(root, 'mypaper');
  mkdirSync(dir, { recursive: true });
  const ext = extname(srcPath).toLowerCase();
  if (!PAPER_EXTS.has(ext)) throw new Error('置けるのは .md / .tex / .typ / .pdf');
  const dest = join(dir, basename(srcPath));
  if (resolve(srcPath) === resolve(dest)) return { path: dest, existed: true };
  if (existsSync(dest)) return { path: dest, existed: true };
  copyFileSync(srcPath, dest);
  return { path: dest, existed: false };
}
