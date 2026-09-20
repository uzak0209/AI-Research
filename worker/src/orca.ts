import { z } from 'zod';

/** OpenAI 互換。キーは Workers Secrets。クライアントに出さない（C-06, ADR-0002） */
export const ORCA_CHAT_URL = 'https://api.orcarouter.ai/v1/chat/completions';

/** C1 は auto 可（ADR-0002）。C3 は固定モデルなのでここを使わない */
export const C1_MODEL = 'orcarouter/auto';

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

/**
 * 本文は返すがログに残さない（ADR-0002）。失敗時もプロンプトを error に載せない。
 */
export async function chatCompletion(
  apiKey: string,
  messages: { role: 'system' | 'user'; content: string }[],
  model = C1_MODEL,
): Promise<OrcaChatResult> {
  const res = await fetch(ORCA_CHAT_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, messages }),
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
    model: parsed.data.model ?? model,
    tokens,
  };
}
