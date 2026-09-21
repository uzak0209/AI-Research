import type { Classification } from '../domain';

export type UsageStore = {
  ensureUser(oauthSubject: string): Promise<string>;
  dailyCallCount(userId: string): Promise<number>;
  record(row: {
    userId: string;
    endpoint: string;
    classification: Classification;
    model: string | null;
    tokens: number;
  }): Promise<void>;
};
