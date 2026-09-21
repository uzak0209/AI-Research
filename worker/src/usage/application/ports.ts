import type { Classification } from '../domain';

export type UsageStore = {
  ensureUser(oauthSubject: string): Promise<string>;
  dailyCallCount(userId: string): Promise<number>;
  record(row: {
    userId: string;
    endpoint: string;
    classification: Classification;
    /** 要求した宛先。Named Router 名またはモデル ID */
    requestedModel: string | null;
    /** 実際に応答したモデル */
    resolvedModel: string | null;
    tokens: number;
    /** 取れなかったときは null。0 として足さない（C-07） */
    costUsd?: number | null;
    latencyMs?: number;
    fallbackUsed?: boolean;
  }): Promise<void>;
};
