/**
 * ADR-0005 §5「形式不正」: 構造化出力のパース失敗（HTTP 200 だが JSON が壊れている）は
 * ゲートウェイでは拾えないため、BFF が別モデルへ 1 回だけ自前で投げ直す（#79）。
 */
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ORCA_CHAT_URL } from '../src/shared/orca/chat';
import { buildSearchQuery } from '../src/collect/application/search-terms';
import { attachProblemExcerpts } from '../src/collect/application/problem-excerpt';
import type { ScoredPaper } from '../src/collect/domain';
import type { Env } from '../src/env';

function orcaBody(content: string, model: string) {
  return {
    model,
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cost_usd: 0.0001 },
  };
}

/** 順に応答を返す。呼び出しごとの model と本文を確認できるよう記録する */
function mockOrcaSequence(responses: { model: string; content: string }[]) {
  const calls: { model: string }[] = [];
  let i = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (!url.startsWith(ORCA_CHAT_URL) && !url.includes('orcarouter.ai')) {
      return new Response('unexpected fetch', { status: 500 });
    }
    const sent = JSON.parse(String(init?.body ?? '{}')) as { model: string };
    calls.push({ model: sent.model });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return new Response(JSON.stringify(orcaBody(r.content, r.model)), { status: 200 });
  });
  return calls;
}

const TEST_ENV: Env = {
  ...env,
  ORCAROUTER_API_KEY_CRON: 'test-cron-key',
  ORCAROUTER_API_KEY_INTERACTIVE: 'test-interactive-key',
  ORCA_ROUTER_COLLECT: 'orcarouter/rs-collect',
  ORCA_ROUTER_REVIEW: 'orcarouter/rs-review',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildSearchQuery の自前フォールバック（収集段）', () => {
  it('1 次が壊れた JSON でも別モデルへ 1 回だけ投げ直して拾う', async () => {
    // 1 次は Named Router（rs-collect）宛て。応答したのは openai/gpt-4o-mini
    const calls = mockOrcaSequence([
      { model: 'openai/gpt-4o-mini', content: 'not json' },
      { model: 'google/gemini-2.5-flash', content: '{"core":["DPDK"],"related":["RSS","XDP"]}' },
    ]);
    const got = await buildSearchQuery(TEST_ENV, 'DPDK packet processing latency');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.model).toBe('orcarouter/rs-collect');
    // 自前フォールバックは実際に応答した openai/gpt-4o-mini とは別モデルを直指定する
    expect(calls[1]!.model).toBe('google/gemini-2.5-flash');
    expect(got.generated).toBe(true);
    expect(got.combo).toContain('DPDK');
    expect(got.usage?.tokens).toBe(40);
  });

  it('2 回とも壊れていれば空で返す。機械的な語の切り出しに落とさない', async () => {
    const calls = mockOrcaSequence([
      { model: 'openai/gpt-4o-mini', content: 'not json' },
      { model: 'google/gemini-2.5-flash', content: 'still not json' },
    ]);
    const got = await buildSearchQuery(TEST_ENV, 'DPDK packet processing latency');
    expect(calls).toHaveLength(2);
    expect(got.generated).toBe(false);
    expect(got.queries).toEqual([]);
  });

  it('1 次が正しい形式なら投げ直さない', async () => {
    const calls = mockOrcaSequence([
      { model: 'openai/gpt-4o-mini', content: '{"core":["DPDK"],"related":["RSS"]}' },
    ]);
    await buildSearchQuery(TEST_ENV, 'DPDK packet processing latency');
    expect(calls).toHaveLength(1);
  });
});

describe('attachProblemExcerpts の自前フォールバック（レビュー段）', () => {
  const papers: ScoredPaper[] = [
    {
      external_id: 'W1',
      title: 'Paper W1',
      authors: 'Ada',
      abstract: 'Existing methods fail on large graphs.',
      url: 'https://example.test/W1',
      published_at: '2026-01-01',
      coarse_score: 1,
      problem_excerpt: null,
    },
  ];

  it('1 次が壊れた JSON でも別モデルへ 1 回だけ投げ直して拾う', async () => {
    // 1 次は Named Router（rs-review）宛て。応答したのは google/gemini-2.5-flash
    const calls = mockOrcaSequence([
      { model: 'google/gemini-2.5-flash', content: 'not json' },
      { model: 'anthropic/claude-haiku-4.5', content: '{"W1":"Existing methods fail on large graphs."}' },
    ]);
    const { papers: out, usage } = await attachProblemExcerpts(TEST_ENV, papers);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.model).toBe('orcarouter/rs-review');
    // レビュー段の自前フォールバックは同格候補（anthropic/claude-haiku-4.5）に落ちる。安価モデルへは落とさない
    expect(calls[1]!.model).toBe('anthropic/claude-haiku-4.5');
    expect(out[0]!.problem_excerpt).toBe('Existing methods fail on large graphs.');
    expect(usage?.tokens).toBe(40);
  });

  it('2 回とも壊れていれば null のまま', async () => {
    const calls = mockOrcaSequence([
      { model: 'google/gemini-2.5-flash', content: 'not json' },
      { model: 'anthropic/claude-haiku-4.5', content: 'still not json' },
    ]);
    const { papers: out } = await attachProblemExcerpts(TEST_ENV, papers);
    expect(calls).toHaveLength(2);
    expect(out[0]!.problem_excerpt).toBeNull();
  });
});
