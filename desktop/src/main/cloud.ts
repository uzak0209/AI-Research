// メインプロセスだけが Worker を叩く。レンダラにトークンを渡さない（ADR-0001）。

import { safeStorage } from 'electron';
import {
  AuthSession,
  CLOUD_ENDPOINT_KEY,
  CloudClient,
  DEFAULT_CLOUD_ENDPOINT,
  createSettingsStore,
  electronBox,
} from '@ai-research/core';
import type { Db } from '../shared/db.js';

export type Cloud = {
  client: CloudClient;
  session: AuthSession;
  endpoint: string;
};

export function createCloud(db: Db): Cloud {
  const settings = createSettingsStore(db);
  const session = new AuthSession(settings, electronBox(safeStorage));
  // ローカル検証は access を環境から載せてもよい（just desktop-cloud）
  const fromEnv = process.env.AI_RESEARCH_ACCESS_TOKEN?.trim();
  if (fromEnv) session.setAccessToken(fromEnv);

  // 既定は prod。ローカル wrangler は AI_RESEARCH_API（just desktop-cloud）
  const endpoint = (
    process.env.AI_RESEARCH_API?.trim() ||
    settings.get(CLOUD_ENDPOINT_KEY)?.value?.trim() ||
    DEFAULT_CLOUD_ENDPOINT
  ).replace(/\/$/, '');

  return { client: new CloudClient(endpoint, session), session, endpoint };
}

export function cloudSignedIn(session: AuthSession): boolean {
  if (session.getAccessToken()) return true;
  return session.getRefreshToken() !== null;
}
