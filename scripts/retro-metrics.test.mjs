#!/usr/bin/env node
// node --test scripts/retro-metrics.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSeries, ratio, trend } from "./retro-metrics.mjs";

describe("ratio", () => {
  it("分母 0 は null（C-07）", () => {
    assert.equal(ratio(10, 0), null);
    assert.equal(ratio(10, null), null);
  });
});

describe("buildSeries score_mean", () => {
  it("粗点の平均と tokens_per_paper を日別に持つ", () => {
    const series = buildSeries(
      [{ d: "2026-09-20", calls: 2, tokens: 200, cost_usd: 0, latency_ms_sum: 0, fallback_calls: 0 }],
      [{ d: "2026-09-20", papers: 4, score_mean: 0.5, scored_papers: 4 }],
      [{ d: "2026-09-20", status: "ok", n: 1 }],
      [],
      "2026-09-20",
    );
    assert.equal(series.length, 1);
    assert.equal(series[0].papers, 4);
    assert.equal(series[0].score_mean, 0.5);
    assert.equal(series[0].tokens_per_paper, 50);
  });

  it("採点が無い日の score_mean は null", () => {
    const series = buildSeries(
      [{ d: "2026-09-21", calls: 1, tokens: 10, cost_usd: 0, latency_ms_sum: 0, fallback_calls: 0 }],
      [{ d: "2026-09-21", papers: 2, score_mean: null, scored_papers: 0 }],
      [],
      [],
      "2026-09-21",
    );
    assert.equal(series[0].score_mean, null);
    assert.equal(series[0].tokens_per_paper, 5);
  });
});

describe("buildSeries fabrication_rate", () => {
  it("抜粋のうち abstract に見つからなかった割合を日別に持つ（ADR-0005 §4-1）", () => {
    const series = buildSeries(
      [],
      [],
      [],
      [{ d: "2026-09-22", excerpts: 4, unverified: 1 }],
      "2026-09-22",
    );
    assert.equal(series[0].excerpts, 4);
    assert.equal(series[0].unverified_excerpts, 1);
    assert.equal(series[0].fabrication_rate, 0.25);
  });

  it("抜粋が無い日は null（0 割りを断定に使わない。C-07）", () => {
    const series = buildSeries([], [], [], [{ d: "2026-09-22", excerpts: 0, unverified: 0 }], "2026-09-22");
    assert.equal(series[0].fabrication_rate, null);
  });
});

describe("trend score_mean", () => {
  it("点数は高い方が良い前提で変化率を出す", () => {
    const scored = [
      { score_mean: 0.2 },
      { score_mean: 0.2 },
      { score_mean: 0.4 },
      { score_mean: 0.4 },
    ];
    const t = trend(scored, "score_mean");
    assert.equal(t.status, "ok");
    assert.ok(t.change_pct > 0);
  });
});
