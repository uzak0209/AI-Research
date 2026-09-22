// ADR-0004 のクラウド側。HTTP と cron を 1 つの Worker に同居させる。
//
// **設計フェーズのデプロイ土台。** 未決の部分は実装したふりをせず 501 を返す（C-07）。
//   - GET /runs・PUT /projects/{id} は課題意識の同期（FR-15 / summary）
//   - Google OAuth は POST /auth/google。JWT 署名鍵の入れ替え手順は未決
//   - BFF は C1（POST /bff/trends・POST /bff/bibliography・POST /bff/keywords）。C2/C3 は同意・プレビュー未決のため 501
//
// Worker は Bearer JWT を検証するだけ。トークンの置き場はクライアント（ADR-0001）。

import { handleFetch } from './http/app';
import { handleQueueMessage, handleScheduled } from './collect';
import type { CollectMessage, Env } from './env';

export type { CollectMessage, Env } from './env';
export { handleFetch } from './http/app';
export { handleQueueMessage, handleScheduled, SOURCES, coarseScore } from './collect';
export { utcDate } from './shared/date';
export { rebuildAbstract } from './shared/papers/domain';

export default {
  fetch: handleFetch,

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(env));
  },

  async queue(batch: MessageBatch<CollectMessage>, env: Env) {
    for (const message of batch.messages) {
      try {
        await handleQueueMessage(message.body, env);
        message.ack();
      } catch {
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, CollectMessage>;
