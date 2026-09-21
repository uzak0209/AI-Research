#!/usr/bin/env node
// ADR-0005 §10: retro-metrics の JSON を、読める形にする。
//
//   node scripts/retro-metrics.mjs --env dev --days 14 > metrics.json
//   node scripts/render-trend.mjs metrics.json >> "$GITHUB_STEP_SUMMARY"
//
// 主指標は 2 つだけ:
//   - トークン / 見つけた論文（低いほど良い）
//   - 点数 = coarse_score 平均（高いほど良い）
// 取得本数は比率の裏付けとして必ず併記する（本数を削れば比率は良くなる）。

import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  process.stderr.write("使い方: node scripts/render-trend.mjs <metrics.json>\n");
  process.exit(1);
}
const m = JSON.parse(readFileSync(path, "utf8"));
const out = [];
const say = (s = "") => out.push(s);

const n2 = (v) => (v === null || v === undefined ? "—" : Number(v).toFixed(2));
const n3 = (v) => (v === null || v === undefined ? "—" : Number(v).toFixed(3));
const int = (v) => (v === null || v === undefined ? "—" : String(v));

say(`## トークン/論文と点数の推移（${m.env} / 直近 ${m.days} 日）`);
say();

if (m.status !== "ok") {
  const label = m.status === "empty" ? "データなし" : "取得失敗";
  say(`> **${label}**`);
  say(">");
  say(`> 期間: ${m.since} 以降 / 対象: ${m.database ?? "(未解決)"}`);
  if (m.reason) say(`> 理由: \`${m.reason}\``);
  say(">");
  say("> グラフは出していない。**欠損を成功と偽らない**（`C-07`）。");
  process.stdout.write(`${out.join("\n")}\n`);
  process.exit(0);
}

say("### 主指標");
say();
say("| 指標 | 前半平均 | 後半平均 | 変化 | n |");
say("|---|---:|---:|---:|---:|");

const verdict = (label, t, fmt, { higherIsBetter = false } = {}) => {
  if (!t || t.status !== "ok") {
    say(`| ${label} | — | — | ${t?.status ?? "—"} | ${t?.n ?? 0} |`);
    return null;
  }
  const note = higherIsBetter
    ? t.change_pct >= 0
      ? "▲良い"
      : "▼悪い"
    : t.change_pct <= 0
      ? "▼良い"
      : "▲悪い";
  say(
    `| ${label} | ${fmt(t.first_half)} | ${fmt(t.second_half)} | ${note} ${Math.abs(t.change_pct).toFixed(1)}% | ${t.n} |`,
  );
  return t.change_pct;
};

const dTok = verdict("トークン/論文 ※低い方が良い", m.trend.tokens_per_paper, n2, {
  higherIsBetter: false,
});
const dScore = verdict("点数 (coarse_score 平均) ※高い方が良い", m.trend.score_mean, n3, {
  higherIsBetter: true,
});
const dPapers = verdict("取得論文数（絶対値）", m.trend.papers, n2, { higherIsBetter: true });

say();
// 比率が良くなっても本数が減っていれば改善ではない
const EXPLAINED_BY_FEWER_PAPERS = 0.5;
const ratioGain = dTok !== null && dTok < 0 ? Math.abs(dTok) : 0;
const papersDrop = dPapers !== null && dPapers < 0 ? Math.abs(dPapers) : 0;

if (ratioGain > 0 && papersDrop >= ratioGain * EXPLAINED_BY_FEWER_PAPERS) {
  say(
    `> **注意: トークン/論文は ${ratioGain.toFixed(1)}% 下がったが、取得論文数も ${papersDrop.toFixed(1)}% 減っている。**` +
      "検索本数が減っただけの可能性が高い。",
  );
} else if (dTok !== null && dTok < 0) {
  say(`> トークン/論文は ${Math.abs(dTok).toFixed(1)}% 下がっている（本数減では説明しにくい）。`);
} else {
  say("> トークン/論文の改善は確認できていない。");
}

if (dScore === null) {
  say("> 点数の比較はできない（採点付き論文の日が足りない）。");
} else if (dScore > 0) {
  say(`> 点数（coarse_score 平均）は ${dScore.toFixed(1)}% 上がっている。`);
} else if (dScore < 0) {
  say(`> 点数（coarse_score 平均）は ${Math.abs(dScore).toFixed(1)}% 下がっている。`);
} else {
  say("> 点数に変化はない。");
}
say();
say(
  `母数: 比較 ${m.totals.days_compared} 日 / 採点あり ${m.totals.days_scored ?? 0} 日 / ` +
    `データのある ${m.totals.days_with_data} 日 / 呼び出し ${m.totals.calls} 回 / ` +
    `論文 ${m.totals.papers} 本（うち採点 ${m.totals.scored_papers ?? 0}）。`,
);
if (m.totals.days_without_papers > 0) {
  say(
    `論文 0 本の日 ${m.totals.days_without_papers} 日はトークン/論文の比較から外した。`,
  );
}
say("n が小さいうちは傾向として読まないこと。");
say();

function chart(title, axis, key, digits) {
  const pts = m.series.filter((e) => e[key] !== null && Number.isFinite(e[key]));
  if (pts.length < 2) return;

  const labels = pts.map((e) => `"${e.date.slice(5)}"`).join(", ");
  const values = pts.map((e) => Number(e[key]).toFixed(digits)).join(", ");
  const nums = pts.map((e) => Number(e[key]));
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const pad = hi === lo ? Math.abs(hi) * 0.1 || 1 : (hi - lo) * 0.1;
  const floor = Math.max(0, lo - pad);

  say("```mermaid");
  say("xychart-beta");
  say(`    title "${title}"`);
  say(`    x-axis [${labels}]`);
  say(`    y-axis "${axis}" ${floor.toFixed(digits)} --> ${(hi + pad).toFixed(digits)}`);
  say(`    line [${values}]`);
  say("```");
  say();
}

say("### グラフ");
say();
chart("トークン / 論文", "tokens", "tokens_per_paper", 1);
chart("点数 (coarse_score 平均)", "score", "score_mean", 3);
chart("取得論文数", "papers", "papers", 0);

say("### 明細");
say();
say("| 日付 | 呼出 | トークン | 論文 | 採点本数 | トークン/論文 | 点数 | run |");
say("|---|---:|---:|---:|---:|---:|---:|---|");
for (const e of m.series) {
  const r = e.runs;
  const runs = [
    r.ok ? `ok:${r.ok}` : null,
    r.partial ? `partial:${r.partial}` : null,
    r.empty ? `empty:${r.empty}` : null,
    r.failed ? `failed:${r.failed}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  say(
    `| ${e.date} | ${int(e.calls)} | ${int(e.tokens)} | ${int(e.papers)} ` +
      `| ${int(e.scored_papers)} | ${n2(e.tokens_per_paper)} | ${n3(e.score_mean)} | ${runs || "—"} |`,
  );
}
say();
say("`—` は割れなかった／採点が無かった日。0 で埋めていない。");

process.stdout.write(`${out.join("\n")}\n`);
