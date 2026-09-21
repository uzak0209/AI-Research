// 作業フォルダ mypaper/ から読む順の正本を拾う（ADR-0001）。
// クラウドへは出さない（C-01）。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chunkText } from './text-chunk.js';

const MYPAPER_EXTS = new Set(['.md', '.tex', '.typ']);

/** 実質の原稿があるか。空ファイル・空白だけは無い扱い */
export function mypaperHasContent(root: string | null | undefined): boolean {
  return loadMypaperChunks(root).length > 0;
}

/** mypaper/ 配下の .md / .tex / .typ をチャンク化して返す */
export function loadMypaperChunks(root: string | null | undefined): string[] {
  if (!root) return [];
  const dir = join(root, 'mypaper');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];

  const files = listMypaperFiles(dir);
  const chunks: string[] = [];
  for (const f of files) {
    let body: string;
    try {
      body = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    chunks.push(...chunkText(body));
  }
  return chunks;
}

function listMypaperFiles(dir: string): string[] {
  const out: string[] = [];
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
      } else if (st.isFile() && MYPAPER_EXTS.has(extname(name).toLowerCase())) {
        out.push(p);
      }
    }
  };
  walk(dir);
  out.sort();
  return out;
}
