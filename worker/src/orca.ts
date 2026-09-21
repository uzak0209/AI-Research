import { z } from 'zod';
import type { Env } from './env';
import { ORCA_POLICY, type OrcaClassPolicy, type OrcaKeySlot } from './orca-policy';

/** OpenAI 互換。キーは Workers Secrets。クライアントに出さない（C-06, ADR-0002） */
export const ORCA_CHAT_URL = 'https://api.orcarouter.ai/v1/chat/completions';

const chatResponseSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable().optional() }).optional(),
      }),
    )
    .optional(),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
      // x-orcarouter-include-cost を付けたときだけ返る
      cost_usd: z.number().optional(),
    })
    .optional(),
});

export type OrcaChatOk = {
  ok: true;
  text: string;
  /** 実際に応答したモデル。後方互換のため名前は model のまま */
  model: string;
  /** 要求した宛先。Named Router 名またはモデル ID */
  requestedModel: string;
  tokens: number;
  /** 取れなかったときは null。0 と「不明」を混ぜない（C-07） */
  costUsd: number | null;
  latencyMs: number;
  /** 要求と応答が食い違った＝受け皿へ落ちた */
  fallbackUsed: boolean;
};
export type OrcaChatFail = { ok: false; status: number };
export type OrcaChatResult = OrcaChatOk | OrcaChatFail;

export function orcaKey(env: Env, slot: OrcaKeySlot): string | undefined {
  if (slot === 'interactive') return env.ORCAROUTER_API_KEY_INTERACTIVE ?? env.ORCAROUTER_API_KEY;
  if (slot === 'cron') return env.ORCAROUTER_API_KEY_CRON ?? env.ORCAROUTER_API_KEY;
  return env.ORCAROUTER_API_KEY_SENSITIVE;
}

export function chatBody(
  policy: OrcaClassPolicy,
  messages: { role: 'system' | 'user'; content: string }[],
) {
  const body: Record<string, unknown> = {
    model: policy.model,
    temperature: policy.temperature,
    messages,
  };
  if (policy.fallbacks.length > 0) {
    body.extra_body = { route: 'fallback', models: [...policy.fallbacks] };
  }
  return body;
}

function servedModel(res: Response, bodyModel: string | undefined, primary: string): string {
  return (
    res.headers.get('x-orca-fallback-model') ??
    res.headers.get('x-orca-resolved-model') ??
    bodyModel ??
    primary
  );
}

/**
 * 本文は返すがログに残さない（ADR-0002）。失敗時もプロンプトを error に載せない。
 * 全滅したら ok:false（fail_open: false）。
 */
export async function chatCompletion(
  apiKey: string,
  messages: { role: 'system' | 'user'; content: string }[],
  policy: OrcaClassPolicy = ORCA_POLICY.C1,
): Promise<OrcaChatResult> {
  // 宛先ごとに比べるため、往復の実時間を測る。上流の応答時間とネットワークを含む
  const startedAt = Date.now();
  const res = await fetch(ORCA_CHAT_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'x-orcarouter-include-cost': 'true',
    },
    body: JSON.stringify(chatBody(policy, messages)),
  });

  if (!res.ok) {
    return { ok: false, status: res.status };
  }

  const parsed = chatResponseSchema.safeParse(await res.json());
  if (!parsed.success) return { ok: false, status: 502 };

  const latencyMs = Date.now() - startedAt;

  const text = parsed.data.choices?.[0]?.message?.content?.trim() ?? '';
  if (!text) return { ok: false, status: 502 };

  const usage = parsed.data.usage;
  const tokens =
    usage?.total_tokens ?? (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0);

  const served = servedModel(res, parsed.data.model, policy.model);

  return {
    ok: true,
    text,
    model: served,
    requestedModel: policy.model,
    tokens,
    costUsd: usage?.cost_usd ?? null,
    latencyMs,
    fallbackUsed: served !== policy.model,
  };
}
