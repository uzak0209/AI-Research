// レンダラへ渡す窓口。Node をそのまま渡さない（contextIsolation は切らない）。
import { contextBridge, ipcRenderer } from 'electron';

const api = {
  platform: process.platform,
  // --- プロジェクト ---
  listProjects: () => ipcRenderer.invoke('projects:list'),
  createProject: (title: string, summary: string) =>
    ipcRenderer.invoke('projects:create', title, summary),
  updateSummary: (projectId: string, summary: string) =>
    ipcRenderer.invoke('projects:updateSummary', projectId, summary),
  updateTitle: (projectId: string, title: string) =>
    ipcRenderer.invoke('projects:updateTitle', projectId, title),
  createWorkspace: () => ipcRenderer.invoke('projects:createWorkspace'),
  openWorkspace: () => ipcRenderer.invoke('projects:openWorkspace'),
  createUnderRecycle: (title: string) =>
    ipcRenderer.invoke('projects:createUnderRecycle', title) as Promise<
      | { ok: true; root: string; title: string; action: 'create' | 'open'; project_id?: string }
      | { ok: false; canceled?: true; error?: string }
    >,
  revealWorkspace: (projectId: string) => ipcRenderer.invoke('projects:revealWorkspace', projectId),
  syncProject: (projectId: string) =>
    ipcRenderer.invoke('projects:sync', projectId) as Promise<{ inserted: number; lastRunId: string | null }>,
  startCollect: (projectId: string) =>
    ipcRenderer.invoke('projects:startCollect', projectId) as Promise<{
      run_id: string;
      run_date: string;
      enqueued: number;
      inserted: number;
      pulled: number;
      statuses: string[];
      timedOut: boolean;
    }>,
  onWorkspaceChanged: (cb: (e: { root: string; title: string; action: 'create' | 'open' }) => void) => {
    const h = (_: unknown, e: { root: string; title: string; action: 'create' | 'open' }) => cb(e);
    ipcRenderer.on('workspace:changed', h);
    return () => ipcRenderer.off('workspace:changed', h);
  },
  onWorkspaceError: (cb: (message: string) => void) => {
    const h = (_: unknown, message: string) => cb(message);
    ipcRenderer.on('workspace:error', h);
    return () => ipcRenderer.off('workspace:error', h);
  },
  onOpenSettings: (cb: () => void) => {
    const h = () => cb();
    ipcRenderer.on('settings:open', h);
    return () => ipcRenderer.off('settings:open', h);
  },

  auth: {
    status: () => ipcRenderer.invoke('auth:status') as Promise<{ signedIn: boolean }>,
    login: () => ipcRenderer.invoke('auth:login') as Promise<{ signedIn: boolean }>,
    logout: () => ipcRenderer.invoke('auth:logout') as Promise<{ signedIn: boolean }>,
    onChanged: (cb: (e: { signedIn: boolean }) => void) => {
      const h = (_: unknown, e: { signedIn: boolean }) => cb(e);
      ipcRenderer.on('auth:changed', h);
      return () => ipcRenderer.off('auth:changed', h);
    },
    onError: (cb: (message: string) => void) => {
      const h = (_: unknown, message: string) => cb(message);
      ipcRenderer.on('auth:error', h);
      return () => ipcRenderer.off('auth:error', h);
    },
  },

  listClaims: (projectId: string) => ipcRenderer.invoke('claims:list', projectId),
  setClaims: (projectId: string, claims: string[]) =>
    ipcRenderer.invoke('claims:set', projectId, claims),

  // --- 新着候補 ---
  ranked: (projectId: string) => ipcRenderer.invoke('papers:ranked', projectId),
  importPapers: (projectId: string, papers: unknown[]) =>
    ipcRenderer.invoke('papers:import', projectId, papers),

  startScoring: (projectId: string) => ipcRenderer.invoke('score:start', projectId),
  cancelScoring: () => ipcRenderer.invoke('score:cancel'),
  onScoreEvent: (cb: (e: unknown) => void) => {
    const h = (_: unknown, e: unknown) => cb(e);
    ipcRenderer.on('score:event', h);
    return () => ipcRenderer.off('score:event', h);
  },

  // --- ライブラリ（FR-05 / FR-14） ---
  lib: {
    list: (projectId: string, filter?: unknown) => ipcRenderer.invoke('lib:list', projectId, filter),
    get: (referenceId: string) => ipcRenderer.invoke('lib:get', referenceId),
    counts: (projectId: string) => ipcRenderer.invoke('lib:counts', projectId),
    tags: (projectId: string) => ipcRenderer.invoke('lib:tags', projectId),

    add: (projectId: string, item: unknown) => ipcRenderer.invoke('lib:add', projectId, item),
    follow: (projectId: string, referenceId: string) =>
      ipcRenderer.invoke('lib:follow', projectId, referenceId),
    update: (referenceId: string, patch: unknown) =>
      ipcRenderer.invoke('lib:update', referenceId, patch),
    remove: (referenceId: string) => ipcRenderer.invoke('lib:delete', referenceId),

    star: (referenceId: string, starred: boolean) =>
      ipcRenderer.invoke('lib:star', referenceId, starred),
    readStatus: (referenceId: string, status: string) =>
      ipcRenderer.invoke('lib:readStatus', referenceId, status),

    addTag: (projectId: string, referenceId: string, name: string) =>
      ipcRenderer.invoke('lib:addTag', projectId, referenceId, name),
    removeTag: (referenceId: string, name: string) =>
      ipcRenderer.invoke('lib:removeTag', referenceId, name),

    getNote: (referenceId: string) => ipcRenderer.invoke('lib:getNote', referenceId),
    saveNote: (referenceId: string, body: string) =>
      ipcRenderer.invoke('lib:saveNote', referenceId, body),

    attachments: (referenceId: string) => ipcRenderer.invoke('lib:attachments', referenceId),
    attachFile: (referenceId: string) => ipcRenderer.invoke('lib:attachFile', referenceId),
    removeAttachment: (attachmentId: string) =>
      ipcRenderer.invoke('lib:removeAttachment', attachmentId),
    openExternally: (path: string) => ipcRenderer.invoke('lib:openExternally', path),
    onChanged: (cb: () => void) => {
      const h = () => cb();
      ipcRenderer.on('library:changed', h);
      return () => ipcRenderer.off('library:changed', h);
    },
  },

  // --- PDF（FR-14） ---
  pdf: {
    /** PDF を選んで文献として取り込む。1 ファイル = 1 文献 */
    import: (projectId: string) => ipcRenderer.invoke('pdf:import', projectId),
    /** 添付の中身を取る。レンダラに fs を渡さないため経由する */
    read: (attachmentId: string) => ipcRenderer.invoke('pdf:read', attachmentId),
    /** 公開書誌を Worker 経由で補う。原稿は送らない。決定はフォルダ追従（ADR-0003）。現行 UI はボタン */
    bibliography: (hint: unknown) => ipcRenderer.invoke('bff:bibliography', hint),
  },

  // --- 書き込み（ハイライト・ペン・コメント） ---
  anno: {
    list: (attachmentId: string) => ipcRenderer.invoke('anno:list', attachmentId),
    addHighlight: (attachmentId: string, a: unknown) =>
      ipcRenderer.invoke('anno:addHighlight', attachmentId, a),
    addInk: (attachmentId: string, a: unknown) => ipcRenderer.invoke('anno:addInk', attachmentId, a),
    comment: (annotationId: string, comment: string) =>
      ipcRenderer.invoke('anno:comment', annotationId, comment),
    remove: (annotationId: string) => ipcRenderer.invoke('anno:remove', annotationId),
    counts: (referenceId: string) => ipcRenderer.invoke('anno:counts', referenceId),
  },
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
