#!/usr/bin/env node
// ADR-0005 §10: retro-metrics の JSON を、読める形にする。
//
//   node scripts/retro-metrics.mjs --env dev --days 14 > metrics.json
//   node scripts/render-trend.mjs metrics.json >> "$GITHUB_STEP_SUMMARY"
//
// 方針:
//   - グラフは Mermaid の xychart-beta。まだ beta なので、描画されなくても
//     数値が読めるように**表を必ず併記する**
//   - 比率（トークン/論文）と絶対値（論文数）を必ず並べる。
//     本数が減って比率が下がったのは改善ではない
//   - 割れない日は null のままにして、0 で埋めない（C-07）

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
const n4 = (v) => (v === null || v === undefined ? "—" : Number(v).toFixed(4));
const int = (v) => (v === null || v === undefined ? "—" : String(v));

say(`## コストとトークンの推移（${m.env} / 直近 ${m.days} 日）`);
say();

// ------------------------------------------------ 取れなかったとき
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

// ------------------------------------------------ 判定
say("### 下がっているか");
say();
say("| 指標 | 前半平均 | 後半平均 | 変化 | n |");
say("|---|---:|---:|---:|---:|");

const verdict = (label, t, fmt) => {
  if (t.status !== "ok") {
    say(`| ${label} | — | — | ${t.status} | ${t.n} |`);
    return null;
  }
  const sign = t.change_pct <= 0 ? "▼" : "▲";
  say(
    `| ${label} | ${fmt(t.first_half)} | ${fmt(t.second_half)} | ${sign} ${Math.abs(t.change_pct).toFixed(1)}% | ${t.n} |`,
  );
  return t.change_pct;
};

const dTok = verdict("トークン/論文", m.trend.tokens_per_paper, n2);
const dCost = verdict("コスト/論文 (USD)", m.trend.cost_per_paper, n4);
const dPapers = verdict("取得論文数", m.trend.papers, n2);
// 生産性だけは上がるほど良い。▼▲ の意味が他行と逆になるので明示する
const dProd = verdict("生産性 (論文/推論秒) ※高い方が良い", m.trend.papers_per_sec, n2);

say();
// 比率が下がっても、本数が減っただけなら改善ではない。
// ただし数 % の揺れで毎回警告すると意味がなくなるので、絶対値の閾値ではなく
// 「比率の改善のうち、どれだけが本数減で説明できるか」で判定する。
// 係数 0.5 は暫定（ADR-0005 の未決）。
const EXPLAINED_BY_FEWER_PAPERS = 0.5;
const ratioGain = dTok !== null && dTok < 0 ? Math.abs(dTok) : 0;
const papersDrop = dPapers !== null && dPapers < 0 ? Math.abs(dPapers) : 0;

if (ratioGain > 0 && papersDrop >= ratioGain * EXPLAINED_BY_FEWER_PAPERS) {
  say(
    `> **注意: 比率は ${ratioGain.toFixed(1)}% 下がったが、取得論文数も ${papersDrop.toFixed(1)}% 減っている。**` +
      "検索本数が減っただけの可能性が高い。改善と呼ぶ前に取得側を確認すること。",
  );
} else if (dCost !== null && dCost < 0) {
  const note =
    papersDrop > 0
      ? `取得論文数の変化は ${dPapers.toFixed(1)}% で、比率改善の主因ではない。`
      : "取得論文数は落ちていない。";
  say(`> コスト/論文は ${Math.abs(dCost).toFixed(1)}% 下がっている。${note}`);
} else {
  say("> 下降は確認できていない。");
}
if (dProd !== null) {
  const dir = dProd >= 0 ? "上がっている" : "下がっている";
  say(`> 生産性（論文/推論秒）は ${Math.abs(dProd).toFixed(1)}% ${dir}。`);
}
say();
say(
  `母数: 比較に使った ${m.totals.days_compared} 日 / データのある ${m.totals.days_with_data} 日 / ` +
    `呼び出し ${m.totals.calls} 回 / 論文 ${m.totals.papers} 本。`,
);
if (m.totals.days_without_papers > 0) {
  say(
    `論文 0 本の日 ${m.totals.days_without_papers} 日は比較から外した` +
      "（比率が出せない日を混ぜると、本数が減ったように見えるため）。",
  );
}
say("n が小さいうちは傾向として読まないこと。");
say();

// ------------------------------------------------ グラフ
// xychart-beta は欠損を表現できないので、値のある日だけを描く。
// 欠けた日は下の表で分かるようにしてある。
function chart(title, axis, key, digits) {
  const pts = m.series.filter((e) => e[key] !== null && Number.isFinite(e[key]));
  if (pts.length < 2) return;

  const labels = pts.map((e) => `"${e.date.slice(5)}"`).join(", ");
  const values = pts.map((e) => Number(e[key]).toFixed(digits)).join(", ");
  const nums = pts.map((e) => Number(e[key]));
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  // 平坦なときに軸が潰れないよう幅を持たせる
  const pad = hi === lo ? Math.abs(hi) * 0.1 || 1 : (hi - lo) * 0.1;
  // トークン数・コスト・本数はいずれも負にならない。軸を負へ伸ばさない
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
chart("コスト / 論文 (USD)", "usd", "cost_per_paper", 4);
chart("取得論文数", "papers", "papers", 0);
chart("生産性（論文 / 推論秒）", "papers/s", "papers_per_sec", 2);

// ------------------------------------------------ 明細
// ------------------------------------------------ 宛先ごとの比較
const routes = m.by_route ?? [];
say("### 宛先ごとの比較");
say();
if (routes.length === 0) {
  say("記録なし。");
} else {
  say("| 宛先 (要求) | 応答したモデル | endpoint | 呼出 | 平均レイテンシ(ms) | トークン/回 | コスト/回(USD) | 受け皿率 |");
  say("|---|---|---|---:|---:|---:|---:|---:|");
  for (const r of routes) {
    const rate = r.fallback_rate === null ? "—" : `${(r.fallback_rate * 100).toFixed(0)}%`;
    say(
      `| \`${r.route}\` | \`${r.resolved_model}\` | ${r.endpoint} | ${int(r.calls)} ` +
        `| ${r.latency_ms_avg === null ? "未計測" : n2(r.latency_ms_avg)} ` +
        `| ${n2(r.tokens_per_call)} | ${n4(r.cost_per_call)} | ${rate} |`,
    );
  }
  say();
  say(
    "要求した宛先と応答したモデルが違う行は、受け皿へ落ちた分。" +
      "**呼出回数が少ない行は平均が揺れるので、回数を見てから読むこと。**",
  );

  // 呼出の多い順に、平均レイテンシを並べる。宛先の速さを一目で比べる用
  const timed = routes.filter((r) => r.latency_ms_avg !== null).slice(0, 8);
  if (timed.length >= 2) {
    const labels = timed.map((r) => `"${r.resolved_model.split("/").pop()}"`).join(", ");
    const values = timed.map((r) => r.latency_ms_avg.toFixed(0)).join(", ");
    const hi = Math.max(...timed.map((r) => r.latency_ms_avg));
    say();
    say("```mermaid");
    say("xychart-beta");
    say('    title "宛先ごとの平均レイテンシ"');
    say(`    x-axis [${labels}]`);
    say(`    y-axis "ms" 0 --> ${Math.ceil(hi * 1.1)}`);
    say(`    bar [${values}]`);
    say("```");
  }
}
say();

say("### 明細");
say();
say("| 日付 | 呼出 | トークン | コスト(USD) | 論文 | 推論(秒) | トークン/論文 | コスト/論文 | 生産性(論文/秒) | run |");
say("|---|---:|---:|---:|---:|---:|---:|---:|---:|---|");
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
    `| ${e.date} | ${int(e.calls)} | ${int(e.tokens)} | ${n4(e.cost_usd)} | ${int(e.papers)} ` +
      `| ${e.latency_ms_sum > 0 ? n2(e.latency_ms_sum / 1000) : "—"} ` +
      `| ${n2(e.tokens_per_paper)} | ${n4(e.cost_per_paper)} | ${n2(e.papers_per_sec)} | ${runs || "—"} |`,
  );
}
say();
say("`—` は割れなかった日（論文 0 本）。0 で埋めていない。");

process.stdout.write(`${out.join("\n")}\n`);
