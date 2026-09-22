import { existsSync, watch, type FSWatcher } from 'node:fs';
import { extname, join } from 'node:path';

const WATCH_EXTS = new Set(['.pdf', '.md', '.tex', '.typ']);

/** mypaper は読む順の正本。ライブラリへは入れない（ADR-0003）。 */
export function watchMypaper(root: string | null, onChange: () => void): FSWatcher | null {
  if (!root) return null;
  const dir = join(root, 'mypaper');
  if (!existsSync(dir)) return null;

  let timer: ReturnType<typeof setTimeout> | null = null;
  const watcher = watch(dir, (_event, filename) => {
    if (!filename) return;
    const ext = extname(filename).toLowerCase();
    if (!WATCH_EXTS.has(ext)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => onChange(), 400);
  });
  return watcher;
}
