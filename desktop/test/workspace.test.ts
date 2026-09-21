import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PROJECT_WORKSPACE_DIRS,
  createProjectWorkspace,
  isProjectWorkspace,
  sanitizeProjectDirName,
} from '../src/shared/workspace.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'airesearch-ws-'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('sanitizeProjectDirName', () => {
  it('前後の空白を落とす', () => {
    expect(sanitizeProjectDirName('  GNN  ')).toBe('GNN');
  });

  it('空・ドット・区切りは落とす', () => {
    expect(() => sanitizeProjectDirName('  ')).toThrow(/空/);
    expect(() => sanitizeProjectDirName('..')).toThrow(/不正/);
    expect(() => sanitizeProjectDirName('a/b')).toThrow(/文字/);
    expect(() => sanitizeProjectDirName('a\\b')).toThrow(/文字/);
  });
});

describe('createProjectWorkspace', () => {
  it('references / mypaper / claims を作る', () => {
    const root = join(dir, 'proj');
    createProjectWorkspace(root);
    expect(isProjectWorkspace(root)).toBe(true);
    for (const d of PROJECT_WORKSPACE_DIRS) {
      expect(isProjectWorkspace(join(root, d))).toBe(false);
    }
  });

  it('既に作業フォルダなら何もしない', () => {
    const root = join(dir, 'proj');
    createProjectWorkspace(root);
    createProjectWorkspace(root);
    expect(isProjectWorkspace(root)).toBe(true);
  });

  it('空の既存フォルダなら中に 3 つを足す', () => {
    const root = join(dir, 'empty');
    mkdirSync(root);
    createProjectWorkspace(root);
    expect(isProjectWorkspace(root)).toBe(true);
  });

  it('中身のある未知のフォルダには作らない（C-08）', () => {
    const root = join(dir, 'busy');
    mkdirSync(root);
    writeFileSync(join(root, 'notes.md'), 'x');
    expect(() => createProjectWorkspace(root)).toThrow(/空でない/);
  });

  it('同じ名前のファイルがあるときは落とす', () => {
    const root = join(dir, 'file');
    writeFileSync(root, 'x');
    expect(() => createProjectWorkspace(root)).toThrow(/ファイル/);
  });
});
