// 1 プロジェクト = 利用者が選んだ作業フォルダ（ADR-0001）。
// 索引の正本は SQLite。ここは原稿・文献・主張の置き場だけで、中身を勝手に書き換えない（C-08）。

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const PROJECT_WORKSPACE_DIRS = ['references', 'mypaper', 'claims'] as const;

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

/** フォルダ名に使えない文字。パス区切りと Windows 禁止文字 */
const FORBIDDEN_NAME = /[<>:"/\\|?*\u0000-\u001f]/;

export function sanitizeProjectDirName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new WorkspaceError('プロジェクト名が空');
  if (name === '.' || name === '..') throw new WorkspaceError('プロジェクト名が不正');
  if (FORBIDDEN_NAME.test(name)) throw new WorkspaceError('プロジェクト名に使えない文字がある');
  return name;
}

function isEmptyDir(root: string): boolean {
  return readdirSync(root).filter((n) => n !== '.DS_Store').length === 0;
}

export function isProjectWorkspace(root: string): boolean {
  return PROJECT_WORKSPACE_DIRS.every((d) => {
    const p = join(root, d);
    return existsSync(p) && statSync(p).isDirectory();
  });
}

/**
 * `{root}/references` `{root}/mypaper` `{root}/claims` を作る。
 * 親は既にあること。空でない未知のフォルダには作らない（C-08）。
 */
export function createProjectWorkspace(root: string): void {
  const parent = dirname(root);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    throw new WorkspaceError('置く場所が無い');
  }

  if (existsSync(root)) {
    if (!statSync(root).isDirectory()) throw new WorkspaceError('同じ名前のファイルがある');
    if (!isEmptyDir(root) && !isProjectWorkspace(root)) {
      throw new WorkspaceError('空でないフォルダには作らない。中身を壊さないため');
    }
  } else {
    mkdirSync(root);
  }

  for (const d of PROJECT_WORKSPACE_DIRS) {
    const p = join(root, d);
    if (existsSync(p)) {
      if (!statSync(p).isDirectory()) throw new WorkspaceError(`${d} と同じ名前のファイルがある`);
      continue;
    }
    mkdirSync(p);
  }
}
