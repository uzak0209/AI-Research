import { z } from 'zod';
import { JEV_POLICY } from './jev-policy';

/** TypeSafe System One。OrcaRouter には無い（ADR-0002）。hono-jev-router は経路用なので使わない */
export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';

const noulAnswerSchema = z.object({
  type: z.literal('noul'),
  noul: z.number(),
});

const choiceAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  confidence: z.number().optional(),
  probabilities: z.record(z.string(), z.number()).optional(),
});

const jevResponseSchema = z.object({
  model: z.string().optional(),
  answers: z.record(z.string(), z.unknown()),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .optional(),
});

export type JevNoul = z.infer<typeof noulAnswerSchema>;
export type JevChoice = z.infer<typeof choiceAnswerSchema>;
export type JevQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> };

export type JevOk = {
  ok: true;
  model: string;
  tokens: number;
  answers: Record<string, unknown>;
};
export type JevFail = { ok: false; status: number };
export type JevResult = JevOk | JevFail;

export function parseNoul(raw: unknown): JevNoul | null {
  const parsed = noulAnswerSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function parseChoice(raw: unknown): JevChoice | null {
  const parsed = choiceAnswerSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * 本文は返すがログに残さない（ADR-0002）。失敗時も state を error に載せない。
 * 全滅したら ok:false（fail_open: false）。
 */
export async function systemOne(
  apiKey: string,
  state: unknown,
  questions: Record<string, JevQuestion>,
  model = JEV_POLICY.C1.model,
): Promise<JevResult> {
  const res = await fetch(JEV_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, state, questions }),
  });

  if (!res.ok) return { ok: false, status: res.status };

  const parsed = jevResponseSchema.safeParse(await res.json());
  if (!parsed.success) return { ok: false, status: 502 };

  const usage = parsed.data.usage;
  const tokens = usage?.input_tokens ?? 0;

  return {
    ok: true,
    model: parsed.data.model ?? model,
    tokens,
    answers: parsed.data.answers,
  };
}
