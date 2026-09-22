import { existsSync, watch, type FSWatcher } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import type { BibliographyApp } from './compose.js';

const WATCH_EXTS = new Set(['.pdf', '.md', '.tex', '.typ']);

export function watchMypaper(
  root: string | null,
  projectId: string,
  app: BibliographyApp,
  onChange: () => void,
): FSWatcher | null {
  if (!root) return null;
  const dir = join(root, 'mypaper');
  if (!existsSync(dir)) return null;

  let timer: ReturnType<typeof setTimeout> | null = null;
  const pendingPdf = new Set<string>();

  const watcher = watch(dir, (_event, filename) => {
    if (!filename) return;
    const ext = extname(filename).toLowerCase();
    if (!WATCH_EXTS.has(ext)) return;
    const path = resolve(dir, filename);
    if (ext === '.pdf' && app.paths.isPdf(filename) && !app.pdfs.wasWritten(path)) {
      pendingPdf.add(path);
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const files = [...pendingPdf];
      pendingPdf.clear();
      void (async () => {
        for (const f of files) {
          try {
            await app.ingestFile(projectId, f);
          } catch {
            // 1 件失敗しても残りは続ける
          }
        }
        onChange();
      })();
    }, 400);
  });
  return watcher;
}
