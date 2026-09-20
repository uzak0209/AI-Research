// ADR-0004 のクラウド側。HTTP と cron を 1 つの Worker に同居させる。
//
// **設計フェーズのデプロイ土台。** 未決の部分は実装したふりをせず 501 を返す（C-07）。
//   - 認証の上流 IdP と署名鍵の入れ替え手順が未決 → /runs は 501
//   - BFF の endpoint は分類決定後に作る（ADR-0002）→ /bff/* は 501
//
// Worker は Bearer JWT を検証するだけ。トークンの置き場はクライアント（ADR-0001）。

import { handleFetch } from './app';
import { handleQueueMessage, handleScheduled } from './collect';
import type { CollectMessage, Env } from './env';

export type { CollectMessage, Env } from './env';
export { handleFetch } from './app';
export { handleQueueMessage, handleScheduled, SOURCES } from './collect';
export { utcDate } from './date';
export { rebuildAbstract } from './openalex';
export { coarseScore } from './score';

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
