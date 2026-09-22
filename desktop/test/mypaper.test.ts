import { describe, expect, it } from 'vitest';
import { chunkText } from '../src/shared/text-chunk.js';
import { copyIntoMypaper, listMypaperEntries, loadMypaperChunks, mypaperHasContent } from '../src/shared/mypaper.js';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('chunkText', () => {
  it('空は空配列', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   ')).toEqual([]);
  });

  it('段落をまとめて上限で切る', () => {
    const chunks = chunkText('aaa\n\nbbb\n\nccc', 7);
    expect(chunks.join(' ')).toContain('aaa');
    expect(chunks.every((c) => c.length <= 7)).toBe(true);
  });
});

describe('mypaper', () => {
  it('空フォルダは content 無し', () => {
    const root = mkdtempSync(join(tmpdir(), 'airesearch-mp-'));
    mkdirSync(join(root, 'mypaper'));
    try {
      expect(mypaperHasContent(root)).toBe(false);
      expect(loadMypaperChunks(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('.md をチャンク化する', () => {
    const root = mkdtempSync(join(tmpdir(), 'airesearch-mp-'));
    mkdirSync(join(root, 'mypaper'));
    writeFileSync(join(root, 'mypaper', 'a.md'), 'hello graph networks\n\nmore text here');
    try {
      expect(mypaperHasContent(root)).toBe(true);
      expect(loadMypaperChunks(root).length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('PDF を mypaper にコピーし、既存は上書きしない', () => {
    const root = mkdtempSync(join(tmpdir(), 'airesearch-mp-'));
    mkdirSync(join(root, 'mypaper'));
    const srcDir = mkdtempSync(join(tmpdir(), 'airesearch-src-'));
    const src = join(srcDir, 'mine.pdf');
    writeFileSync(src, '%PDF-1.4 fake');
    try {
      const first = copyIntoMypaper(root, src);
      expect(first.existed).toBe(false);
      expect(existsSync(first.path)).toBe(true);
      expect(listMypaperEntries(root).some((e) => e.kind === 'pdf' && e.name === 'mine.pdf')).toBe(true);
      expect(mypaperHasContent(root)).toBe(true);

      writeFileSync(src, '%PDF-1.4 changed');
      const second = copyIntoMypaper(root, src);
      expect(second.existed).toBe(true);
      expect(second.path).toBe(first.path);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(srcDir, { recursive: true, force: true });
    }
  });

  it('pdf/md/tex/typ 以外は置かない', () => {
    const root = mkdtempSync(join(tmpdir(), 'airesearch-mp-'));
    mkdirSync(join(root, 'mypaper'));
    const src = join(root, 'notes.txt');
    writeFileSync(src, 'no');
    try {
      expect(() => copyIntoMypaper(root, src)).toThrow(/置けるのは/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
