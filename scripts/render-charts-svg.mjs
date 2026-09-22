#!/usr/bin/env node
// metrics.json → SVG 折れ線（依存なし）。GitHub README で確実に見えるようにする。
//
//   node scripts/render-charts-svg.mjs metrics.json docs/
//
// 出すファイル:
//   docs/metrics-tokens.svg  — トークン/論文
//   docs/metrics-score.svg   — 点数 (coarse_score 平均)
//   docs/metrics-papers.svg  — 取得論文数

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const metricsPath = process.argv[2];
const outDir = process.argv[3] || "docs";
if (!metricsPath) {
  process.stderr.write("使い方: node scripts/render-charts-svg.mjs <metrics.json> [outDir]\n");
  process.exit(1);
}

const m = JSON.parse(readFileSync(metricsPath, "utf8"));
mkdirSync(outDir, { recursive: true });

const W = 720;
const H = 280;
const PAD = { t: 36, r: 24, b: 48, l: 56 };

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function lineChart({ title, axis, key, color, digits = 2, emptyNote }) {
  const pts = (m.series || []).filter((e) => e[key] !== null && Number.isFinite(Number(e[key])));
  if (pts.length < 2) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">
  <rect width="100%" height="100%" fill="#fafafa"/>
  <text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="#666" font-family="ui-sans-serif,system-ui,sans-serif" font-size="14">${esc(emptyNote || `${title}: 点が足りない`)}</text>
</svg>
`;
  }

  const nums = pts.map((e) => Number(e[key]));
  let lo = Math.min(...nums);
  let hi = Math.max(...nums);
  if (hi === lo) {
    const pad = Math.abs(hi) * 0.1 || 1;
    lo = Math.max(0, lo - pad);
    hi = hi + pad;
  } else {
    const pad = (hi - lo) * 0.1;
    lo = Math.max(0, lo - pad);
    hi = hi + pad;
  }

  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const xAt = (i) => PAD.l + (pts.length === 1 ? iw / 2 : (i / (pts.length - 1)) * iw);
  const yAt = (v) => PAD.t + ih - ((v - lo) / (hi - lo)) * ih;

  const poly = pts.map((e, i) => `${xAt(i).toFixed(1)},${yAt(Number(e[key])).toFixed(1)}`).join(" ");
  const dots = pts
    .map((e, i) => {
      const x = xAt(i);
      const y = yAt(Number(e[key]));
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="${color}"/>`;
    })
    .join("\n  ");

  // x labels: show up to ~8 ticks
  const step = Math.max(1, Math.ceil(pts.length / 8));
  const xLabels = pts
    .map((e, i) => {
      if (i % step !== 0 && i !== pts.length - 1) return "";
      const label = String(e.date).slice(5);
      return `<text x="${xAt(i).toFixed(1)}" y="${H - 16}" text-anchor="middle" fill="#555" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">${esc(label)}</text>`;
    })
    .filter(Boolean)
    .join("\n  ");

  const yTicks = 4;
  const yGrid = [];
  for (let i = 0; i <= yTicks; i++) {
    const v = lo + ((hi - lo) * i) / yTicks;
    const y = yAt(v);
    yGrid.push(
      `<line x1="${PAD.l}" y1="${y.toFixed(1)}" x2="${W - PAD.r}" y2="${y.toFixed(1)}" stroke="#eee"/>`,
    );
    yGrid.push(
      `<text x="${PAD.l - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="#555" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">${v.toFixed(digits)}</text>`,
    );
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="${PAD.l}" y="22" fill="#111" font-family="ui-sans-serif,system-ui,sans-serif" font-size="15" font-weight="600">${esc(title)}</text>
  <text x="${W - PAD.r}" y="22" text-anchor="end" fill="#888" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">${esc(axis)} · ${esc(m.env || "")}</text>
  ${yGrid.join("\n  ")}
  <polyline fill="none" stroke="${color}" stroke-width="2.5" points="${poly}"/>
  ${dots}
  ${xLabels}
</svg>
`;
}

const charts = [
  {
    file: "metrics-tokens.svg",
    title: "トークン / 論文",
    axis: "tokens",
    key: "tokens_per_paper",
    color: "#2563eb",
    digits: 1,
    emptyNote: "トークン/論文: 点が足りない（論文 0 本の日ばかり）",
  },
  {
    file: "metrics-score.svg",
    title: "点数 (coarse_score 平均)",
    axis: "score",
    key: "score_mean",
    color: "#059669",
    digits: 3,
    emptyNote: "点数: 採点付きの日が足りない",
  },
  {
    file: "metrics-papers.svg",
    title: "取得論文数",
    axis: "papers",
    key: "papers",
    color: "#b45309",
    digits: 0,
    emptyNote: "取得論文数: データなし",
  },
];

if (m.status !== "ok") {
  for (const c of charts) {
    const svg = lineChart({
      ...c,
      emptyNote: `取得失敗またはデータなし (${m.status})`,
    });
    // force empty by clearing series path — rewrite with note only
    writeFileSync(
      join(outDir, c.file),
      `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="100%" height="100%" fill="#fafafa"/>
  <text x="${W / 2}" y="${H / 2 - 8}" text-anchor="middle" fill="#666" font-family="ui-sans-serif,system-ui,sans-serif" font-size="14">${esc(c.title)}</text>
  <text x="${W / 2}" y="${H / 2 + 16}" text-anchor="middle" fill="#999" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">status=${esc(m.status)}${m.reason ? ` · ${esc(m.reason)}` : ""}</text>
</svg>
`,
    );
  }
} else {
  for (const c of charts) {
    writeFileSync(join(outDir, c.file), lineChart(c));
  }
}

process.stdout.write(`wrote ${charts.map((c) => join(outDir, c.file)).join(", ")}\n`);
