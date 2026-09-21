import { z } from 'zod';
import type { Env } from '../../env';
import { ORCA_POLICY, type OrcaClassPolicy, type OrcaKeySlot } from './policy';

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
    })
    .optional(),
});

export type OrcaChatOk = { ok: true; text: string; model: string; tokens: number };
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
  json = false,
) {
  const body: Record<string, unknown> = {
    model: policy.model,
    temperature: policy.temperature,
    messages,
  };
  if (json) body.response_format = { type: 'json_object' };
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
  json = false,
): Promise<OrcaChatResult> {
  const res = await fetch(ORCA_CHAT_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'x-orcarouter-include-cost': 'true',
    },
    body: JSON.stringify(chatBody(policy, messages, json)),
  });

  if (!res.ok) {
    return { ok: false, status: res.status };
  }

  const parsed = chatResponseSchema.safeParse(await res.json());
  if (!parsed.success) return { ok: false, status: 502 };

  const text = parsed.data.choices?.[0]?.message?.content?.trim() ?? '';
  if (!text) return { ok: false, status: 502 };

  const usage = parsed.data.usage;
  const tokens =
    usage?.total_tokens ?? (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0);

  return {
    ok: true,
    text,
    model: servedModel(res, parsed.data.model, policy.model),
    tokens,
  };
}
