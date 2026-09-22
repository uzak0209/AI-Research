export {
  CloudClient,
  NotSignedInError,
  type BibliographyHint,
  type BibliographyRecord,
  type CollectAccepted,
  type SyncPaper,
  type SyncRun,
  type SyncRunsResponse,
} from './cloud.js';
export {
  createPkce,
  googleAuthorizeUrl,
  parseOAuthCallback,
  randomOAuthState,
  type OAuthCallback,
} from './oauth.js';
export { electronBox, testBox, type SecretBox } from './secret-box.js';
export { AuthSession } from './session.js';
export {
  CLOUD_ENDPOINT_KEY,
  DEFAULT_CLOUD_ENDPOINT,
  EXPORT_BIB_PATH_KEY,
  EXPORT_FORMAT_KEY,
  REFRESH_KEY,
  createSettingsStore,
  type SettingRow,
  type SettingsStore,
} from './settings.js';

// ローカルストア（FR-11）。GUI（desktop/src/shared/*.ts は再 export のみ）と
// CLI（packages/cli）が同じ実装をここ経由で共有する。二重管理しない
export * from './store/db.js';
export * from './store/repo.js';
export * from './store/library.js';
