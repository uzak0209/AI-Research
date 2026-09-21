import { describe, expect, it } from 'vitest';
import { chunkText } from '../src/shared/text-chunk.js';
import { loadMypaperChunks, mypaperHasContent } from '../src/shared/mypaper.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
});
