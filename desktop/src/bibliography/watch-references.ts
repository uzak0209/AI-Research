import { existsSync, watch, type FSWatcher } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BibliographyApp } from './compose.js';

export function watchReferences(
  root: string | null,
  projectId: string,
  app: BibliographyApp,
  onChange: () => void,
): FSWatcher | null {
  if (!root) return null;
  const dir = join(root, 'references');
  if (!existsSync(dir)) return null;

  let timer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Set<string>();

  const watcher = watch(dir, (_event, filename) => {
    if (!filename || !app.paths.isPdf(filename)) return;
    const path = resolve(dir, filename);
    if (app.pdfs.wasWritten(path)) return;
    pending.add(path);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const files = [...pending];
      pending.clear();
      void (async () => {
        for (const f of files) {
          try {
            await app.ingestFile(projectId, f);
          } catch {
            // 1 件失敗しても残りは続ける。呼び出し側が library:changed で一覧を更新する
          }
        }
        onChange();
      })();
    }, 400);
  });
  return watcher;
}
