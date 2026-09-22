# @ai-research/core

GUI と CLI が共有するローカル側（ADR-0001）。認証と Worker への HTTP クライアント。

| 持つもの | 置き場 |
|---|---|
| 更新トークン | `settings.auth.refresh_token_enc`（`safeStorage` で暗号化、`encrypted=true`） |
| アクセストークン | メモリのみ（`AuthSession`） |
| Worker URL | `settings.cloud.endpoint`。無ければ prod `https://ai-research.streeeak.link`。ローカルは `AI_RESEARCH_API` |

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

## ローカルストア（`src/store/`）

`db.ts`（`openDb` / スキーマ）・`repo.ts`（プロジェクト・論文・採点）・`library.ts`
（参考文献ライブラリ）。desktop（`src/main/index.ts`）と CLI（`packages/cli`）の両方が
ここだけを通してローカル SQLite を触る（二重管理しない）。desktop 側の
`src/shared/{db,repo,library}.ts` は既存 import を変えずに済ませるための再 export。

ベクトル拡張（sqlite-vec）は `openDb({ vector: false })` で読み込みを省ける。
参考文献ライブラリ（`reference_items` / `tags` / `notes`）は埋め込みを使わないため、
CLI はこちらを使う。

### CLI から使うとき

`.` エクスポートは TypeScript ソースのままなので Electron の bundler（vite）前提。
バンドラを持たない CLI からは `npm run build` で吐く `dist/` を
`@ai-research/core/node` から import する。

```sh
npm install   # このディレクトリで
npm run build # dist/ を生成（CLI が使う）
```
