// メインプロセス。DB を開き、UI からの要求を受け、採点は utilityProcess へ逃がす。
//
// 原則:
//   - 採点をここで回さない。ウィンドウのイベント処理が止まる（NFR-06）
//   - レンダラに Node を渡さない。contextIsolation を切らない
//   - 失敗を握りつぶさない。UI とログに出す（C-07）

import { BrowserWindow, app, ipcMain, utilityProcess, type UtilityProcess } from 'electron';
import { appendFileSync } from 'node:fs';
import { EOL } from 'node:os';
import { join } from 'node:path';
import { openDb, VectorExtensionError, type Db } from '../shared/db.js';
import {
  addToLibrary,
  countUnscored,
  createProject,
  listChunks,
  listLibrary,
  listProjects,
  listRanked,
  setManuscript,
  updateSummary,
  upsertPapers,
} from '../shared/repo.js';
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

  ipcMain.handle('library:list', (_e, projectId: string) => listLibrary(db, projectId));

  ipcMain.handle('library:add', (_e, projectId: string, item: Parameters<typeof addToLibrary>[2]) =>
    addToLibrary(db, projectId, item),
  );
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
