// レンダラへ渡す窓口。Node をそのまま渡さない（contextIsolation は切らない）。
import { contextBridge, ipcRenderer } from 'electron';

const api = {
  listProjects: () => ipcRenderer.invoke('projects:list'),
  createProject: (title: string, summary: string) =>
    ipcRenderer.invoke('projects:create', title, summary),
  updateSummary: (projectId: string, summary: string) =>
    ipcRenderer.invoke('projects:updateSummary', projectId, summary),

  listClaims: (projectId: string) => ipcRenderer.invoke('claims:list', projectId),
  setClaims: (projectId: string, claims: string[]) =>
    ipcRenderer.invoke('claims:set', projectId, claims),

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

  listLibrary: (projectId: string) => ipcRenderer.invoke('library:list', projectId),
  addToLibrary: (projectId: string, item: unknown) =>
    ipcRenderer.invoke('library:add', projectId, item),
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
