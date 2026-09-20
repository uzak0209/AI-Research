// UI。関連度順に出すだけで、有効／除外の断定はしない（ADR-0001）。
//
// 表示の原則:
//   - 未採点は「未採点 n 件」と**実数**で出す。推定しない（C-07）
//   - 採点前の順位を先出ししない（楽観的 UI を採らない）
//   - 失敗は黙らず出す

import type { Api } from '../preload/index.js';

declare global {
  interface Window {
    api: Api;
  }
}

interface RankedPaper {
  paper_id: string;
  title: string;
  abstract: string | null;
  url: string | null;
  relevance: number | null;
  sim_summary: number | null;
  nearest_chunk_text: string | null;
  nearest_chunk_sim: number | null;
  in_library: number;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  summary: $<HTMLTextAreaElement>('summary'),
  claims: $<HTMLTextAreaElement>('claims'),
  save: $<HTMLButtonElement>('save'),
  score: $<HTMLButtonElement>('score'),
  cancel: $<HTMLButtonElement>('cancel'),
  status: $<HTMLDivElement>('status'),
  list: $<HTMLDivElement>('list'),
};

let projectId = '';

function setStatus(text: string, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
}

function scoring(active: boolean) {
  els.score.disabled = active;
  els.save.disabled = active;
  els.cancel.disabled = !active;
}

async function boot() {
  const projects = (await window.api.listProjects()) as { project_id: string; summary: string }[];
  const p =
    projects[0] ??
    ((await window.api.createProject('新しいプロジェクト', '')) as { project_id: string; summary: string });

  projectId = p.project_id;
  els.summary.value = p.summary ?? '';

  const claims = (await window.api.listClaims(projectId)) as { text: string }[];
  els.claims.value = claims.map((c) => c.text).join('\n');

  await refresh();
}

async function refresh() {
  const { ranked, unscored } = (await window.api.ranked(projectId)) as {
    ranked: RankedPaper[];
    unscored: number;
  };

  els.list.replaceChildren();

  if (unscored > 0) {
    const pending = document.createElement('div');
    pending.className = 'pending';
    // 実数で出す。「およそ」や残り時間の推定はしない
    pending.textContent = `未採点 ${unscored} 件（採点するまで順位は出ません）`;
    els.list.append(pending);
  }

  if (ranked.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent =
      unscored > 0 ? '採点を実行すると順位が出ます。' : '論文がまだありません。';
    els.list.append(empty);
    return;
  }

  ranked.forEach((r, i) => {
    const item = document.createElement('div');
    item.className = 'item';

    const head = document.createElement('div');
    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = String(i + 1).padStart(2, ' ');
    const score = document.createElement('span');
    score.className = 'score';
    score.textContent = r.relevance?.toFixed(4) ?? '-';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = ` ${r.title}`;
    head.append(rank, score, title);

    item.append(head);

    if (r.nearest_chunk_text) {
      const near = document.createElement('div');
      near.className = 'near';
      // 最近傍という事実だけを書く。「競合している」等の断定はしない
      near.textContent = `近い自分の主張（${r.nearest_chunk_sim?.toFixed(3)}）: ${r.nearest_chunk_text}`;
      item.append(near);
    }

    els.list.append(item);
  });
}

els.save.addEventListener('click', async () => {
  try {
    await window.api.updateSummary(projectId, els.summary.value.trim());
    const claims = els.claims.value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    await window.api.setClaims(projectId, claims);
    setStatus('保存した。採点し直しが必要。');
    await refresh();
  } catch (e) {
    setStatus(`保存に失敗: ${String(e)}`, true);
  }
});

els.score.addEventListener('click', async () => {
  scoring(true);
  setStatus('採点を開始した…');
  try {
    await window.api.startScoring(projectId);
  } catch (e) {
    scoring(false);
    setStatus(`採点を開始できない: ${String(e)}`, true);
  }
});

els.cancel.addEventListener('click', () => {
  void window.api.cancelScoring();
  setStatus('中止を要求した。済んだ分は残る。');
});

window.api.onScoreEvent((raw) => {
  const e = raw as
    | { type: 'progress'; done: number; total: number }
    | { type: 'done'; scored: number }
    | { type: 'error'; message: string };

  if (e.type === 'progress') {
    setStatus(`採点中 ${e.done} / ${e.total} 件`);
    if (e.done % 5 === 0) void refresh(); // 済んだ分から順に出す
  } else if (e.type === 'done') {
    scoring(false);
    setStatus(`採点した: ${e.scored} 件`);
    void refresh();
  } else {
    scoring(false);
    // 失敗を「0 件採点した」に見せない
    setStatus(`採点に失敗: ${e.message}`, true);
    void refresh();
  }
});

void boot().catch((e) => setStatus(`起動に失敗: ${String(e)}`, true));
