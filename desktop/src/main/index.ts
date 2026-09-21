// メインプロセス。DB を開き、UI からの要求を受け、採点は utilityProcess へ逃がす。
//
// 原則:
//   - 採点をここで回さない。ウィンドウのイベント処理が止まる（NFR-06）
//   - レンダラに Node を渡さない。contextIsolation を切らない
//   - 失敗を握りつぶさない。UI とログに出す（C-07）

import { NotSignedInError } from '@ai-research/core';
import { BrowserWindow, Menu, app, dialog, ipcMain, nativeTheme, shell, utilityProcess, type BrowserWindowConstructorOptions, type MenuItemConstructorOptions, type UtilityProcess } from 'electron';
import { appendFileSync, readFileSync, type FSWatcher } from 'node:fs';
import { basename, join } from 'node:path';
import { EOL } from 'node:os';
import { createBibliographyApp, type BibliographyApp } from '../bibliography/compose.js';
import { watchReferences } from '../bibliography/watch-references.js';
import { hintFromReference } from '../bibliography/domain/record.js';
import { openDb, VectorExtensionError, type Db } from '../shared/db.js';
import {
  countUnscored,
  countUnscoredMissingFulltext,
  createProject,
  getProject,
  listChunks,
  listProjects,
  listRanked,
  setManuscript,
  setProjectRoot,
  updateSummary,
  updateTitle,
  upsertPapers,
} from '../shared/repo.js';
import { syncProjectFromCloud, cloudSummaryFromLocal } from '../shared/sync.js';
import { mypaperHasContent } from '../shared/mypaper.js';
import { ensureCandidateFulltexts } from '../shared/candidate-pdf.js';
import {
  WorkspaceError,
  createProjectWorkspace,
  pathUnderProjectsRoot,
  ensureProjectsRoot,
  ensureCandidatesDir,
} from '../shared/workspace.js';
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
import { cloudSignedIn, createCloud } from './cloud.js';
import { runGoogleLogin } from './google-login.js';
import type { ScoreEvent, ScoreRequest } from './score-worker.js';

const DEFAULT_MODEL = 'Xenova/bge-small-en-v1.5';

let db: Db;
let win: BrowserWindow | null = null;
let scorer: UtilityProcess | null = null;
let cloud: ReturnType<typeof createCloud> | null = null;
let biblio: BibliographyApp | null = null;
let refWatch: FSWatcher | null = null;

const dbPath = () => join(app.getPath('userData'), 'ai-research.db');
const modelCacheDir = () => join(app.getPath('userData'), 'models');

/**
 * タイトルバーは OS の流儀に合わせる（VS Code と同じ）。
 * macOS: 信号機は左。Windows: キャプションボタンは右。Linux: 枠は OS に任せる。
 */
function windowChrome(dark: boolean): BrowserWindowConstructorOptions {
  if (process.platform === 'darwin') {
    return { titleBarStyle: 'hiddenInset' };
  }
  if (process.platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: dark ? '#1b1f23' : '#ffffff',
        symbolColor: dark ? '#e9ecef' : '#1a1d21',
        height: 38,
      },
    };
  }
  return {};
}

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
  const dark = nativeTheme.shouldUseDarkColors;
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    ...windowChrome(dark),
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

let scoringPrep: Promise<void> | null = null;

async function prepareAndStartScoring(projectId: string, model: string): Promise<void> {
  if (scorer || scoringPrep) return;

  scoringPrep = (async () => {
    const project = getProject(db, projectId);
    if (project?.root_path && mypaperHasContent(project.root_path) && biblio) {
      try {
        await ensureCandidateFulltexts(db, projectId, project.root_path, {
          gateway: biblio.gateway,
          pdfs: biblio.pdfs,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        win?.webContents.send('score:event', {
          type: 'error',
          message: `候補 PDF の取得に失敗: ${message}`,
        });
        // 取れた分だけで採点を続ける
      }
    }
    startScoring(projectId, model);
  })().finally(() => {
    scoringPrep = null;
  });

  await scoringPrep;
}

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

type WorkspaceOk = { ok: true; root: string; title: string; action: 'create' | 'open' };
type WorkspaceFail = { ok: false; canceled?: true; error?: string };
type WorkspaceResult = WorkspaceOk | WorkspaceFail;

function currentProject() {
  return listProjects(db)[0] ?? null;
}

function notifyLibrary(): void {
  win?.webContents.send('library:changed');
}

function restartRefWatch(): void {
  refWatch?.close();
  refWatch = null;
  if (!biblio) return;
  const p = currentProject();
  if (!p?.root_path) return;
  refWatch = watchReferences(p.root_path, p.project_id, biblio, notifyLibrary);
}

function attachWorkspace(root: string, title: string, action: 'create' | 'open'): WorkspaceOk {
  const existing =
    action === 'open'
      ? listProjects(db).find((p) => p.root_path === root)
      : undefined;
  const p =
    existing ??
    createProject(db, {
      title,
      summary: '',
      embed_model: DEFAULT_MODEL,
      root_path: root,
    });
  if (existing) {
    setProjectRoot(db, p.project_id, root);
    updateTitle(db, p.project_id, title);
  } else if (action === 'create') {
    // createProject で root を入れた。タイトルだけ揃える
    updateTitle(db, p.project_id, title);
  }
  try {
    ensureCandidatesDir(root);
  } catch {
    // 開けた作業フォルダで candidates が作れなくても落とさない
  }
  restartRefWatch();
  return { ok: true, root, title, action };
}

function failWorkspace(e: unknown): WorkspaceFail {
  const error = e instanceof WorkspaceError || e instanceof Error ? e.message : String(e);
  return { ok: false, error };
}

/** ファイルメニュー／ダイアログから。規定の置き場は ~/Recycle。毎回新しいプロジェクト行を作る。 */
async function createWorkspaceFromDialog(): Promise<WorkspaceResult> {
  let defaultPath: string;
  try {
    defaultPath = pathUnderProjectsRoot('新しいプロジェクト');
  } catch (e) {
    return failWorkspace(e);
  }
  const picked = await dialog.showSaveDialog({
    title: 'プロジェクトを作る',
    defaultPath,
    buttonLabel: '作る',
    nameFieldLabel: 'プロジェクト名',
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
  try {
    createProjectWorkspace(picked.filePath);
  } catch (e) {
    return failWorkspace(e);
  }
  return attachWorkspace(picked.filePath, basename(picked.filePath), 'create');
}

/** 既存プロジェクトを開く。規定の場所 ~/Recycle から選ぶ。 */
async function openWorkspaceFromDialog(): Promise<WorkspaceResult> {
  let defaultPath: string;
  try {
    defaultPath = ensureProjectsRoot();
  } catch (e) {
    return failWorkspace(e);
  }
  const picked = await dialog.showOpenDialog({
    title: 'プロジェクトを開く',
    defaultPath,
    buttonLabel: '開く',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };
  const root = picked.filePaths[0];
  try {
    createProjectWorkspace(root);
  } catch (e) {
    return failWorkspace(e);
  }
  return attachWorkspace(root, basename(root), 'open');
}

/** ウェルカム用。ダイアログなしで ~/Recycle/<名前> に**新しい**プロジェクトを作る。 */
function createProjectUnderRecycle(title: string): WorkspaceResult & { project_id?: string } {
  try {
    const root = pathUnderProjectsRoot(title);
    createProjectWorkspace(root);
    const attached = attachWorkspace(root, basename(root), 'create');
    const p = listProjects(db).find((x) => x.root_path === root);
    return { ...attached, project_id: p?.project_id };
  } catch (e) {
    return failWorkspace(e);
  }
}

function publishWorkspace(res: WorkspaceResult): WorkspaceResult {
  if (res.ok) {
    win?.webContents.send('workspace:changed', res);
    return res;
  }
  if (!res.canceled && res.error) {
    void dialog.showMessageBox({ type: 'error', title: 'プロジェクト', message: res.error });
    win?.webContents.send('workspace:error', res.error);
  }
  return res;
}

function publishAuth(): { signedIn: boolean } {
  if (!cloud) return { signedIn: false };
  const signedIn = cloudSignedIn(cloud.session);
  win?.webContents.send('auth:changed', { signedIn });
  installAppMenu();
  return { signedIn };
}

function pushProjectToCloud(projectId: string): void {
  if (!cloud || !cloudSignedIn(cloud.session)) return;
  const p = getProject(db, projectId);
  if (!p) return;
  const summary = cloudSummaryFromLocal(p.summary, listChunks(db, projectId));
  void cloud.client
    .putProject(projectId, { title: p.title, summary })
    .catch((e) => {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof NotSignedInError) win?.webContents.send('auth:error', message);
      else win?.webContents.send('workspace:error', message);
    });
}

async function syncAllProjectsFromCloud(): Promise<void> {
  if (!cloud || !cloudSignedIn(cloud.session)) return;
  for (const p of listProjects(db)) {
    try {
      const { inserted } = await syncProjectFromCloud(db, cloud.client, p.project_id);
      if (inserted > 0 || countUnscored(db, p.project_id) > 0) {
        void prepareAndStartScoring(p.project_id, DEFAULT_MODEL);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof NotSignedInError) {
        win?.webContents.send('auth:error', message);
        return;
      }
      win?.webContents.send('workspace:error', message);
      logStartup('同期に失敗: ' + message);
    }
  }
}

async function loginFromMenu(): Promise<{ signedIn: boolean }> {
  if (!cloud) throw new Error('クラウドクライアントが無い');
  await runGoogleLogin(cloud.client, async (url) => {
    await shell.openExternal(url);
  });
  const r = publishAuth();
  await syncAllProjectsFromCloud();
  return r;
}

function logoutCloud(): { signedIn: boolean } {
  cloud?.session.clear();
  return publishAuth();
}

function openSettingsFromMenu(): void {
  win?.webContents.send('settings:open');
}

function installAppMenu(): void {
  const isMac = process.platform === 'darwin';
  const signedIn = cloud ? cloudSignedIn(cloud.session) : false;
  const fileSubmenu: MenuItemConstructorOptions[] = [
    {
      label: 'プロジェクトを作る…',
      accelerator: 'CmdOrCtrl+Shift+N',
      click: () => {
        void createWorkspaceFromDialog().then(publishWorkspace);
      },
    },
    {
      label: 'プロジェクトを開く…',
      accelerator: 'CmdOrCtrl+O',
      click: () => {
        void openWorkspaceFromDialog().then(publishWorkspace);
      },
    },
    { type: 'separator' },
    isMac ? { role: 'close' } : { role: 'quit' },
  ];
  const accountItems: MenuItemConstructorOptions[] = signedIn
    ? [
        {
          label: 'ログアウト',
          click: () => {
            logoutCloud();
          },
        },
      ]
    : [
        {
          label: 'Google でログイン',
          click: () => {
            void loginFromMenu().catch((e) => {
              const message = e instanceof Error ? e.message : String(e);
              win?.webContents.send('auth:error', message);
            });
          },
        },
      ];

  const macAppMenu: MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      {
        label: '設定…',
        accelerator: 'Command+,',
        click: () => openSettingsFromMenu(),
      },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  };

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [macAppMenu] : []),
    { label: 'ファイル', submenu: fileSubmenu },
    {
      label: isMac ? 'アカウント' : '設定',
      submenu: isMac
        ? accountItems
        : [
            {
              label: '設定…',
              accelerator: 'Ctrl+,',
              click: () => openSettingsFromMenu(),
            },
            { type: 'separator' },
            ...accountItems,
          ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- IPC --------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle('auth:status', () => publishAuth());
  ipcMain.handle('auth:login', () => loginFromMenu());
  ipcMain.handle('auth:logout', () => logoutCloud());

  ipcMain.handle('projects:list', () => listProjects(db));

  ipcMain.handle('projects:create', (_e, title: string, summary: string) => {
    const p = createProject(db, { title, summary, embed_model: DEFAULT_MODEL });
    pushProjectToCloud(p.project_id);
    return p;
  });

  ipcMain.handle('projects:updateSummary', (_e, projectId: string, summary: string) => {
    updateSummary(db, projectId, summary);
    pushProjectToCloud(projectId);
  });

  ipcMain.handle('projects:updateTitle', (_e, projectId: string, title: string) => {
    updateTitle(db, projectId, title);
  });

  /**
   * 保存パネルで名前と場所を決め、references / mypaper / claims を作る。
   * 空でない既存フォルダには作らない（C-08）。ファイルメニューからも同じ処理。
   */
  ipcMain.handle('projects:createWorkspace', () => createWorkspaceFromDialog());

  ipcMain.handle('projects:openWorkspace', () => openWorkspaceFromDialog());

  ipcMain.handle('projects:createUnderRecycle', (_e, title: string) => {
    const res = createProjectUnderRecycle(title);
    if (res.ok) {
      const p = currentProject();
      if (p) pushProjectToCloud(p.project_id);
    }
    return res;
  });

  ipcMain.handle('projects:revealWorkspace', async (_e, projectId: string) => {
    const p = getProject(db, projectId);
    if (!p?.root_path) return { ok: false as const, error: 'プロジェクトの場所が未設定' };
    const err = await shell.openPath(p.root_path);
    return err ? { ok: false as const, error: err } : { ok: true as const };
  });

  ipcMain.handle('projects:sync', async (_e, projectId: string) => {
    if (!cloud) throw new Error('クラウドクライアントが無い');
    const result = await syncProjectFromCloud(db, cloud.client, projectId);
    if (result.inserted > 0 || countUnscored(db, projectId) > 0) {
      void prepareAndStartScoring(projectId, DEFAULT_MODEL);
    }
    return result;
  });

  ipcMain.handle('projects:startCollect', async (_e, projectId: string) => {
    if (!cloud) throw new Error('クラウドクライアントが無い');
    if (!cloudSignedIn(cloud.session)) throw new NotSignedInError();

    const project = getProject(db, projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    if (!project.summary.trim()) throw new Error('課題意識が空です');

    const summary = cloudSummaryFromLocal(project.summary, listChunks(db, projectId));
    await cloud.client.putProject(projectId, { title: project.title, summary });
    const accepted = await cloud.client.startCollect(projectId);

    let inserted = 0;
    let pulled = 0;
    let timedOut = true;
    let statuses: string[] = [];
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const result = await syncProjectFromCloud(db, cloud.client, projectId);
      inserted += result.inserted;
      pulled += result.pulled;
      if (result.statuses.length > 0) statuses = result.statuses;
      const current = getProject(db, projectId);
      if (current?.last_run_id === accepted.run_id || result.inserted > 0 || result.pulled > 0) {
        timedOut = false;
        break;
      }
    }

    if (inserted > 0 || countUnscored(db, projectId) > 0) {
      void prepareAndStartScoring(projectId, DEFAULT_MODEL);
    }

    return {
      run_id: accepted.run_id,
      run_date: accepted.run_date,
      enqueued: accepted.enqueued,
      inserted,
      pulled,
      statuses,
      timedOut,
    };
  });

  ipcMain.handle('claims:list', (_e, projectId: string) => listChunks(db, projectId));

  ipcMain.handle('claims:set', (_e, projectId: string, claims: string[]) => {
    const ids = setManuscript(
      db,
      projectId,
      claims.map((t) => ({ text: t })),
    );
    pushProjectToCloud(projectId);
    return ids;
  });

  ipcMain.handle('papers:ranked', (_e, projectId: string) => {
    const project = getProject(db, projectId);
    const mode = mypaperHasContent(project?.root_path) ? 'mypaper' : 'blend';
    return {
      ranked: listRanked(db, projectId),
      // 「未採点 n 件」を実数で返す。推定しない（C-07）
      unscored: countUnscored(db, projectId),
      unscoredMissingPdf: mode === 'mypaper' ? countUnscoredMissingFulltext(db, projectId) : 0,
      scoreMode: mode as 'mypaper' | 'blend',
    };
  });

  ipcMain.handle('papers:import', (_e, projectId: string, papers: Parameters<typeof upsertPapers>[2]) =>
    upsertPapers(db, projectId, papers),
  );

  ipcMain.handle('score:start', (_e, projectId: string) => {
    void prepareAndStartScoring(projectId, DEFAULT_MODEL);
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

  ipcMain.handle('lib:add', async (_e, projectId: string, item: ReferenceInput) => {
    const reference_id = addReference(db, projectId, item);
    let pdf: 'ok' | 'exists' | 'not_pdf' | 'failed' | 'skipped' = 'skipped';
    if (biblio) {
      try {
        const got = await biblio.follow(projectId, reference_id);
        pdf = got.pdf;
      } catch {
        // 書誌／PDF 失敗でも文献行は残す（C-07）
        pdf = 'failed';
      }
      notifyLibrary();
    }
    return { reference_id, pdf };
  });

  ipcMain.handle('lib:follow', async (_e, projectId: string, referenceId: string) => {
    if (!biblio) throw new Error('書誌パイプラインが無い');
    return biblio.follow(projectId, referenceId);
  });
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
   * 書誌はローカルだけで取れる範囲を埋め、ログインしていれば BFF で補う。
   * PDF の実体は移動もコピーもしない。選ばれた場所のパスを覚えるだけ（C-08）。
   */
  ipcMain.handle('pdf:import', async (_e, projectId: string) => {
    if (!biblio) throw new Error('書誌パイプラインが無い');
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
        const got = await biblio.ingestFile(projectId, file);
        const row = biblio.refs.get(got.reference_id);
        imported.push({
          reference_id: got.reference_id,
          title: row?.title ?? basename(file).replace(/\.pdf$/i, ''),
          path: file,
          guessed: got.guessed,
          doi: row?.doi ?? null,
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

  /** 公開書誌の補完。Worker の POST /bff/bibliography。フォルダ追従以外の手動ボタン用 */
  ipcMain.handle('bff:bibliography', async (_e, raw: {
    title?: string;
    authors?: string | null;
    year?: number | null;
    doi?: string | null;
    url?: string | null;
    venue?: string | null;
    abstract?: string | null;
  }) => {
    if (!biblio) throw new Error('書誌パイプラインが無い');
    return biblio.gateway.complete(
      hintFromReference({
        title: raw.title ?? '',
        authors: raw.authors,
        year: raw.year,
        doi: raw.doi,
        url: raw.url,
        venue: raw.venue,
        abstract: raw.abstract,
      }),
    );
  });

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
    cloud = createCloud(db);
    biblio = createBibliographyApp(db, () => cloud?.client ?? null);
    logStartup('クラウド API: ' + cloud.endpoint);
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
    restartRefWatch();
    app.setName('AI-Research');
    installAppMenu();
    createWindow();
    logStartup('ウィンドウを作った');
    if (cloudSignedIn(cloud.session)) {
      void syncAllProjectsFromCloud();
    }
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
  refWatch?.close();
  db?.close();
});
