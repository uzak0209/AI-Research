#!/usr/bin/env node
// ADR-0005 §10: 内省の材料を決定的に出す。
//
// D1 を読んで集計値だけを JSON で出す。生データ（summary 本文・検索語・要旨）は出さない。
// ここが「LLM が触れてよい情報」の境界になる。
//
// 使い方:
//   node scripts/retro-metrics.mjs --env dev --days 14 > metrics.json
//
// 必要な環境変数（deploy-worker.yml と同じ Secret を流用する）:
//   CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN
//
// D1 の database_id は秘密ではないので worker/wrangler.jsonc から読む。
//
// 読めないときは異常終了せず、status を付けて出す。
// 「データが無い」と「取得に失敗した」を区別する（C-07）。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

// ---------------------------------------------------------------- 引数
function parseArgs(argv) {
  const out = { env: "dev", days: 14 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--env") out.env = argv[i + 1];
    if (argv[i] === "--days") out.days = Number(argv[i + 1]);
  }
  if (!["dev", "prod"].includes(out.env)) throw new Error(`--env は dev か prod: ${out.env}`);
  if (!Number.isInteger(out.days) || out.days < 1) throw new Error(`--days が不正: ${out.days}`);
  return out;
}

// ---------------------------------------------------------------- 設定
// wrangler.jsonc は行コメントだけを含む。文字列中に // は無い前提で落とす。
function readDatabaseId(env) {
  const raw = readFileSync(join(REPO, "worker", "wrangler.jsonc"), "utf8");
  const stripped = raw
    .split("\n")
    .map((line) => line.replace(/^[ \t]*\/\/.*$/, ""))
    .join("\n");
  const cfg = JSON.parse(stripped);
  const db = cfg?.env?.[env]?.d1_databases?.[0];
  if (!db?.database_id) throw new Error(`wrangler.jsonc に ${env} の database_id が無い`);
  if (db.database_id.startsWith("PLACEHOLDER_")) {
    throw new Error(`${env} の D1 が未構築（database_id が PLACEHOLDER_ のまま）`);
  }
  return { id: db.database_id, name: db.database_name };
}

// ---------------------------------------------------------------- D1
async function query(ctx, sql, params = []) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ctx.accountId}/d1/database/${ctx.databaseId}/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ctx.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ sql, params }),
  });

  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) {
    const detail = body?.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    throw new Error(detail);
  }
  // 単一クエリでも result は配列で返る
  return body.result?.[0]?.results ?? [];
}

export function sinceDate(days) {
  const t = Date.now() - (days - 1) * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- 集計
const SQL_USAGE = `
  SELECT usage_date AS d,
         SUM(calls)          AS calls,
         SUM(tokens)         AS tokens,
         SUM(cost_usd)       AS cost_usd,
         SUM(fallback_calls) AS fallback_calls
  FROM llm_usage
  WHERE usage_date >= ?
  GROUP BY usage_date
  ORDER BY usage_date
`;

const SQL_PAPERS = `
  SELECT r.run_date AS d, COUNT(p.external_id) AS papers
  FROM runs r
  LEFT JOIN run_papers p ON p.run_id = r.run_id
  WHERE r.run_date >= ?
  GROUP BY r.run_date
  ORDER BY r.run_date
`;

const SQL_RUNS = `
  SELECT run_date AS d, status, COUNT(*) AS n
  FROM runs
  WHERE run_date >= ?
  GROUP BY run_date, status
  ORDER BY run_date
`;

// 宛先ごとの比較。model は Named Router 名またはモデル ID。
// 推論時間は合計で持っているので、平均は latency_ms_sum / calls で出す。
const SQL_BY_ROUTE = `
  SELECT model                AS route,
         resolved_model       AS resolved,
         endpoint,
         SUM(calls)           AS calls,
         SUM(tokens)          AS tokens,
         SUM(cost_usd)        AS cost_usd,
         SUM(latency_ms_sum)  AS latency_ms_sum,
         SUM(fallback_calls)  AS fallback_calls
  FROM llm_usage
  WHERE usage_date >= ?
  GROUP BY model, resolved_model, endpoint
  ORDER BY SUM(calls) DESC
`;

// 比率は「割れないときは null」にする。0 で埋めると改善に見えてしまう（C-07）
export function ratio(numerator, denominator) {
  if (!denominator) return null;
  return numerator / denominator;
}

export function buildSeries(usage, papers, runs, since) {
  const byDate = new Map();
  const touch = (d) => {
    if (!byDate.has(d)) {
      byDate.set(d, {
        date: d,
        calls: 0,
        tokens: 0,
        cost_usd: 0,
        fallback_calls: 0,
        papers: 0,
        runs: { ok: 0, empty: 0, failed: 0, partial: 0 },
      });
    }
    return byDate.get(d);
  };

  for (const r of usage) {
    const e = touch(r.d);
    e.calls = Number(r.calls ?? 0);
    e.tokens = Number(r.tokens ?? 0);
    e.cost_usd = Number(r.cost_usd ?? 0);
    e.fallback_calls = Number(r.fallback_calls ?? 0);
  }
  for (const r of papers) touch(r.d).papers = Number(r.papers ?? 0);
  for (const r of runs) {
    const e = touch(r.d);
    if (r.status in e.runs) e.runs[r.status] = Number(r.n ?? 0);
  }

  return [...byDate.values()]
    .filter((e) => e.date >= since)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((e) => ({
      ...e,
      tokens_per_paper: ratio(e.tokens, e.papers),
      cost_per_paper: ratio(e.cost_usd, e.papers),
    }));
}

// 宛先ごとの 1 回あたりの値。latency と cost は合計で入っているので calls で割る。
// 呼び出しが無い行は割らずに null にする（0 と「不明」を混ぜない。C-07）
export function routeRows(rows) {
  return rows
    .map((r) => {
      const calls = Number(r.calls ?? 0);
      const tokens = Number(r.tokens ?? 0);
      const cost = Number(r.cost_usd ?? 0);
      const latencySum = Number(r.latency_ms_sum ?? 0);
      const fallback = Number(r.fallback_calls ?? 0);
      return {
        route: r.route || "(不明)",
        resolved_model: r.resolved || "(不明)",
        endpoint: r.endpoint,
        calls,
        tokens,
        cost_usd: cost,
        fallback_calls: fallback,
        tokens_per_call: ratio(tokens, calls),
        cost_per_call: ratio(cost, calls),
        // latency_ms_sum が 0 のままなら未計測（0003 より前の行）。平均を 0 と言わない
        latency_ms_avg: latencySum > 0 ? ratio(latencySum, calls) : null,
        fallback_rate: ratio(fallback, calls),
      };
    })
    .sort((a, b) => b.calls - a.calls);
}

// 前半と後半の平均を比べる。n を必ず添えて、少ない母数で断定しない材料にする
export function trend(series, key) {
  const vals = series.map((e) => e[key]).filter((v) => v !== null && Number.isFinite(v));
  if (vals.length < 4) return { status: "母数不足", n: vals.length };

  const half = Math.floor(vals.length / 2);
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const first = mean(vals.slice(0, half));
  const second = mean(vals.slice(half));
  if (first === 0) return { status: "比較不能", n: vals.length };

  return {
    status: "ok",
    n: vals.length,
    first_half: first,
    second_half: second,
    change_pct: ((second - first) / first) * 100,
  };
}

// ---------------------------------------------------------------- 本体
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const since = sinceDate(args.days);
  const base = { generated_at: new Date().toISOString(), env: args.env, days: args.days, since };

  const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
  const token = (process.env.CLOUDFLARE_API_TOKEN ?? "").trim();
  if (!accountId || !token) {
    return { ...base, status: "unavailable", reason: "CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN が未設定" };
  }

  let db;
  try {
    db = readDatabaseId(args.env);
  } catch (err) {
    return { ...base, status: "unavailable", reason: String(err.message) };
  }

  const ctx = { accountId, token, databaseId: db.id };
  let usage, papers, runs, byRoute;
  try {
    [usage, papers, runs, byRoute] = await Promise.all([
      query(ctx, SQL_USAGE, [since]),
      query(ctx, SQL_PAPERS, [since]),
      query(ctx, SQL_RUNS, [since]),
      query(ctx, SQL_BY_ROUTE, [since]),
    ]);
  } catch (err) {
    // テーブル未作成もここに来る。取得失敗として残す（0 件とは区別する）
    return { ...base, database: db.name, status: "unavailable", reason: String(err.message) };
  }

  const series = buildSeries(usage, papers, runs, since);
  const sum = (key) => series.reduce((a, e) => a + e[key], 0);

  // 比率は論文 0 本の日に出せない。3 指標を同じ窓で比べないと
  // 「0 本の日が後半に入ったせいで本数が減った」という誤検出が出る。
  // 取得できた日だけで比べ、除外した日数は別に数える（C-07）。
  const comparable = series.filter((e) => e.papers > 0);

  return {
    ...base,
    database: db.name,
    status: series.length ? "ok" : "empty",
    totals: {
      days_with_data: series.length,
      days_compared: comparable.length,
      days_without_papers: series.length - comparable.length,
      calls: sum("calls"),
      tokens: sum("tokens"),
      cost_usd: sum("cost_usd"),
      papers: sum("papers"),
      fallback_calls: sum("fallback_calls"),
    },
    trend: {
      tokens_per_paper: trend(comparable, "tokens_per_paper"),
      cost_per_paper: trend(comparable, "cost_per_paper"),
      papers: trend(comparable, "papers"),
    },
    by_route: routeRows(byRoute),
    series,
  };
}

// 直接実行したときだけ走らせる。import したときは純粋関数だけを使える
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main()
    .then((out) => {
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    })
    .catch((err) => {
      // 想定外だけは異常終了させる。握りつぶさない
      process.stderr.write(`retro-metrics: ${err?.stack ?? err}\n`);
      process.exit(1);
    });
}
