// メインプロセス。DB を開き、UI からの要求を受け、採点は utilityProcess へ逃がす。
//
// 原則:
//   - 採点をここで回さない。ウィンドウのイベント処理が止まる（NFR-06）
//   - レンダラに Node を渡さない。contextIsolation を切らない
//   - 失敗を握りつぶさない。UI とログに出す（C-07）

import { BrowserWindow, app, dialog, ipcMain, shell, utilityProcess, type UtilityProcess } from 'electron';
import { appendFileSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { EOL } from 'node:os';
import { join } from 'node:path';
import { openDb, VectorExtensionError, type Db } from '../shared/db.js';
import {
  countUnscored,
  createProject,
  listChunks,
  listProjects,
  listRanked,
  setManuscript,
  updateSummary,
  upsertPapers,
} from '../shared/repo.js';
import {
  addAttachment,
  addReference,
  addTag,
  deleteReference,
  getNote,
  getReference,
  libraryCounts,
  listAttachments,
  listReferences,
  listTags,
  removeAttachment,
  removeTag,
  saveNote,
  setReadStatus,
  setStarred,
  updateReference,
  type LibraryFilter,
  type ReadStatus,
  type ReferenceInput,
} from '../shared/library.js';
import {
  addHighlight,
  addInk,
  countAnnotations,
  listAnnotations as listAnnos,
  removeAnnotation,
  setComment,
  type HighlightInput,
  type InkInput,
} from '../shared/annotations.js';
import { extractFromPdf, lookupByDoi } from '../shared/pdf-import.js';
import type { ScoreEvent, ScoreRequest } from './score-worker.js';

const DEFAULT_MODEL = 'Xenova/bge-small-en-v1.5';

let db: Db;
let win: BrowserWindow | null = null;
let scorer: UtilityProcess | null = null;

const dbPath = () => join(app.getPath('userData'), 'ai-research.db');
const modelCacheDir = () => join(app.getPath('userData'), 'models');

/**
 * Windows の GUI プロセスは stdout が端末に出ない。
 * 起動時の失敗を黙って消さないよう userData にログを残す（C-07）。
 */
function logStartup(line: string): void {
  try {
    appendFileSync(join(app.getPath('userData'), 'startup.log'), new Date().toISOString() + ' ' + line + EOL);
  } catch {
    // ログに書けないこと自体で起動を止めない
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload から contextBridge を使うため
    },
  });

  win.once('ready-to-show', () => win?.show());

  win.webContents.on('preload-error', (_e, path, error) => {
    logStartup('preload に失敗: ' + path + ' ' + error.message);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    logStartup('レンダラが落ちた: ' + details.reason);
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
}

// --- 採点（utilityProcess） ---------------------------------------------------

function startScoring(projectId: string, model: string): void {
  if (scorer) return; // 二重起動させない

  scorer = utilityProcess.fork(join(import.meta.dirname, 'score-worker.js'));

  scorer.on('message', (e: ScoreEvent) => {
    win?.webContents.send('score:event', e);
    if (e.type === 'done' || e.type === 'error') {
      scorer?.kill();
      scorer = null;
    }
  });

  scorer.on('exit', (code) => {
    // 何も言わずに消えると「採点されなかった」ことに気づけない
    if (scorer) win?.webContents.send('score:event', { type: 'error', message: '採点プロセスが終了した (code=' + code + ')' });
    scorer = null;
  });

  const req: ScoreRequest = {
    type: 'score',
    dbPath: dbPath(),
    projectId,
    model,
    cacheDir: modelCacheDir(),
  };
  scorer.postMessage(req);
}

// --- IPC --------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle('projects:list', () => listProjects(db));

  ipcMain.handle('projects:create', (_e, title: string, summary: string) =>
    createProject(db, { title, summary, embed_model: DEFAULT_MODEL }),
  );

  ipcMain.handle('projects:updateSummary', (_e, projectId: string, summary: string) => {
    updateSummary(db, projectId, summary);
  });

  ipcMain.handle('claims:list', (_e, projectId: string) => listChunks(db, projectId));

  ipcMain.handle('claims:set', (_e, projectId: string, claims: string[]) =>
    setManuscript(
      db,
      projectId,
      claims.map((t) => ({ text: t })),
    ),
  );

  ipcMain.handle('papers:ranked', (_e, projectId: string) => ({
    ranked: listRanked(db, projectId),
    // 「未採点 n 件」を実数で返す。推定しない（C-07）
    unscored: countUnscored(db, projectId),
  }));

  ipcMain.handle('papers:import', (_e, projectId: string, papers: Parameters<typeof upsertPapers>[2]) =>
    upsertPapers(db, projectId, papers),
  );

  ipcMain.handle('score:start', (_e, projectId: string) => {
    startScoring(projectId, DEFAULT_MODEL);
  });

  ipcMain.handle('score:cancel', () => {
    scorer?.postMessage({ type: 'cancel' });
  });

  // --- ライブラリ（FR-05 / FR-14） ---
  ipcMain.handle('lib:list', (_e, projectId: string, filter: LibraryFilter) =>
    listReferences(db, projectId, filter ?? {}),
  );
  ipcMain.handle('lib:get', (_e, referenceId: string) => getReference(db, referenceId));
  ipcMain.handle('lib:counts', (_e, projectId: string) => libraryCounts(db, projectId));
  ipcMain.handle('lib:tags', (_e, projectId: string) => listTags(db, projectId));

  ipcMain.handle('lib:add', (_e, projectId: string, item: ReferenceInput) =>
    addReference(db, projectId, item),
  );
  ipcMain.handle('lib:update', (_e, referenceId: string, patch: Partial<ReferenceInput>) =>
    updateReference(db, referenceId, patch),
  );
  ipcMain.handle('lib:delete', (_e, referenceId: string) => deleteReference(db, referenceId));

  ipcMain.handle('lib:star', (_e, referenceId: string, starred: boolean) =>
    setStarred(db, referenceId, starred),
  );
  ipcMain.handle('lib:readStatus', (_e, referenceId: string, status: ReadStatus) =>
    setReadStatus(db, referenceId, status),
  );

  ipcMain.handle('lib:addTag', (_e, projectId: string, referenceId: string, name: string) =>
    addTag(db, projectId, referenceId, name),
  );
  ipcMain.handle('lib:removeTag', (_e, referenceId: string, name: string) =>
    removeTag(db, referenceId, name),
  );

  ipcMain.handle('lib:getNote', (_e, referenceId: string) => getNote(db, referenceId));
  ipcMain.handle('lib:saveNote', (_e, referenceId: string, body: string) =>
    saveNote(db, referenceId, body),
  );

  ipcMain.handle('lib:attachments', (_e, referenceId: string) => listAttachments(db, referenceId));
  ipcMain.handle('lib:removeAttachment', (_e, attachmentId: string) =>
    removeAttachment(db, attachmentId),
  );

  // ファイル選択はメイン側でしかできない。パスだけを保持し、実体は動かさない（C-08）
  ipcMain.handle('lib:attachFile', async (_e, referenceId: string) => {
    const r = await dialog.showOpenDialog({
      title: 'PDF を添付',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['openFile'],
    });
    if (r.canceled || r.filePaths.length === 0) return null;
    return addAttachment(db, referenceId, r.filePaths[0]!);
  });

  ipcMain.handle('lib:openExternally', async (_e, path: string) => {
    const err = await shell.openPath(path);
    // 開けなかったことを黙って握りつぶさない（C-07）
    return err || null;
  });

  // --- PDF から文献を作る ---

  /**
   * PDF を選んで取り込む。1 ファイル = 1 文献。
   * 書誌はローカルだけで取れる範囲を埋め、**取れなかったものは空のままにする**（C-07）。
   * PDF の実体は移動もコピーもしない。選ばれた場所のパスを覚えるだけ（C-08）。
   */
  ipcMain.handle('pdf:import', async (_e, projectId: string) => {
    const picked = await dialog.showOpenDialog({
      title: 'PDF を取り込む',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (picked.canceled || picked.filePaths.length === 0) return { imported: [], failed: [] };

    const imported: { reference_id: string; title: string; path: string; guessed: boolean; doi: string | null }[] = [];
    const failed: { path: string; error: string }[] = [];

    for (const file of picked.filePaths) {
      try {
        const meta = await extractFromPdf(new Uint8Array(readFileSync(file)));
        // 表題が取れなければファイル名を使う。推測であることは guessed で示す
        const title = meta.title ?? basename(file).replace(/\.pdf$/i, '');
        const refId = addReference(db, projectId, {
          title,
          authors: meta.authors,
          year: meta.year,
          doi: meta.doi,
        });
        addAttachment(db, refId, file);
        imported.push({
          reference_id: refId,
          title,
          path: file,
          guessed: meta.sources.title !== 'info',
          doi: meta.doi,
        });
      } catch (e) {
        // 1 件失敗しても残りは続ける。ただし失敗を隠さない
        failed.push({ path: file, error: e instanceof Error ? e.message : String(e) });
      }
    }

    return { imported, failed };
  });

  /** 添付 PDF の中身をレンダラへ渡す。レンダラに fs を渡さないため */
  ipcMain.handle('pdf:read', (_e, attachmentId: string) => {
    const row = db
      .prepare('SELECT path FROM attachments WHERE attachment_id = ?')
      .get(attachmentId) as { path: string } | undefined;
    if (!row) throw new Error('添付が見つからない');
    // ファイルが移動・削除されていれば例外になる。空を返して「0 ページ」に見せない
    const buf = readFileSync(row.path);
    return { path: row.path, data: new Uint8Array(buf) };
  });

  /** DOI から書誌を引く。**DOI が外部 API に出る。**呼ぶかは UI 側で利用者が選ぶ */
  ipcMain.handle('pdf:lookupDoi', async (_e, doi: string) => lookupByDoi(doi));

  // --- 書き込み（ハイライト・ペン・コメント） ---

  ipcMain.handle('anno:list', (_e, attachmentId: string) => listAnnos(db, attachmentId));

  ipcMain.handle('anno:addHighlight', (_e, attachmentId: string, a: HighlightInput) =>
    addHighlight(db, attachmentId, a),
  );

  ipcMain.handle('anno:addInk', (_e, attachmentId: string, a: InkInput) => addInk(db, attachmentId, a));

  ipcMain.handle('anno:comment', (_e, annotationId: string, comment: string) =>
    setComment(db, annotationId, comment),
  );

  ipcMain.handle('anno:remove', (_e, annotationId: string) => removeAnnotation(db, annotationId));

  ipcMain.handle('anno:counts', (_e, referenceId: string) => countAnnotations(db, referenceId));
}

// --- 起動 --------------------------------------------------------------------

void app.whenReady().then(() => {
  logStartup('起動: electron=' + process.versions.electron + ' node=' + process.versions.node);

  try {
    db = openDb({ path: dbPath() });
    logStartup('DB を開いた: ' + dbPath());
  } catch (e) {
    // ベクトル拡張が読めないまま起動すると検索が静かに壊れる。
    // 黙って縮退せず、理由を残して落とす（C-07）
    const detail = e instanceof VectorExtensionError ? e.message : String(e);
    logStartup('DB を開けなかった: ' + detail);
    app.exit(1);
    return;
  }

  try {
    registerIpc();
    createWindow();
    logStartup('ウィンドウを作った');
  } catch (e) {
    logStartup('ウィンドウ作成に失敗: ' + (e instanceof Error ? (e.stack ?? e.message) : String(e)));
    app.exit(1);
    return;
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

process.on('uncaughtException', (e) => {
  logStartup('未捕捉の例外: ' + (e.stack ?? e.message));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  scorer?.kill();
  db?.close();
});
