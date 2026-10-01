import type { Classification } from '../domain';

/** ADR-0005 §1 の段。retro は router-retro 自身の呼び出し（未使用。将来の予約） */
export type CallStage = '1段目' | '2段目' | 'retro';

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
  /**
   * ADR-0005 §9・§10: `llm_calls`（1 呼び出し 1 行）。
   * runs に紐付く収集パイプライン（1 段目・2 段目・トレンド）だけが呼ぶ。
   * 対話専用 endpoint は run_id を持たないため runId は null 可。
   */
  recordCall(row: {
    runId: string | null;
    endpoint: string;
    classification: Classification;
    stage: CallStage;
    /** Named Router 名。C1 直指定は null */
    router: string | null;
    requestedModel: string | null;
    resolvedModel: string | null;
    /** 受け皿へ落ちた先。落ちていなければ null */
    fallbackTarget: string | null;
    tokensIn: number;
    tokensOut: number;
    costUsd?: number | null;
    durationMs?: number | null;
    /** コード側の出力検査結果。未実装の間は null（C-07） */
    guardrailResult?: string | null;
    /** 失敗時のみ。成功なら null */
    failureReason?: string | null;
  }): Promise<void>;
};
