# @ai-research/core

GUI と CLI が共有するローカル側（ADR-0001）。いまあるのは認証だけ。

| 持つもの | 置き場 |
|---|---|
| 更新トークン | `settings.auth.refresh_token_enc`（`safeStorage` で暗号化、`encrypted=true`） |
| アクセストークン | メモリのみ（`AuthSession`） |

レンダラはこれを import しない。メインプロセスが IPC でクラウドへ中継する。

```ts
import { safeStorage } from 'electron';
import Database from 'better-sqlite3';
import { AuthSession, CloudClient, createSettingsStore, electronBox } from '@ai-research/core';

const db = new Database(sqlitePath);
const session = new AuthSession(createSettingsStore(db), electronBox(safeStorage));
const cloud = new CloudClient(endpoint, session);

// OAuth 完了後
session.setRefreshToken(refresh);
session.setAccessToken(access);

await cloud.fetch('/runs');
```

CLI は同じ SQLite を読む。`safeStorage` は Electron 内だけ動くので、
クラウド API を叩く CLI は GUI と同じランタイム経由か、一度 GUI でログインしたあとの復号ができる環境が要る。
ライブラリ操作（FR-11）はトークン無しでローカル DB だけで足りる。
