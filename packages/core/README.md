# @ai-research/core

GUI と CLI が共有するローカル側（ADR-0001）。認証と Worker への HTTP クライアント。

| 持つもの | 置き場 |
|---|---|
| 更新トークン | `settings.auth.refresh_token_enc`（`safeStorage` で暗号化、`encrypted=true`） |
| アクセストークン | メモリのみ（`AuthSession`） |
| Worker URL | `settings.cloud.endpoint`。無ければ `http://127.0.0.1:8787` |

レンダラはこれを import しない。メインプロセスが IPC でクラウドへ中継する。

```ts
import { safeStorage } from 'electron';
import { AuthSession, CloudClient, createSettingsStore, electronBox } from '@ai-research/core';

const session = new AuthSession(createSettingsStore(db), electronBox(safeStorage));
const cloud = new CloudClient(endpoint, session);

session.setRefreshToken(refresh);
session.setAccessToken(access);

await cloud.fetch('/runs');
await cloud.trends(topic);          // POST /bff/trends
await cloud.bibliography({ doi });  // POST /bff/bibliography
await cloud.loginGoogle({ code, code_verifier, redirect_uri });
```

デスクトップの SQLite は `node:sqlite`（better-sqlite3 ではない）。
`createSettingsStore` は `exec` / `prepare` があればどちらでも動く。

CLI は同じ SQLite を読む。`safeStorage` は Electron 内だけ動くので、
クラウド API を叩く CLI は GUI と同じランタイム経由か、一度 GUI でログインしたあとの復号ができる環境が要る。
ライブラリ操作（FR-11）はトークン無しでローカル DB だけで足りる。
