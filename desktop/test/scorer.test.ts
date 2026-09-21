// 採点エンジンの検証。埋め込みは差し替えて決定的に確かめる。
// 重点は「途中で止まっても嘘をつかないこと」（C-07 / NFR-06）。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMBED_DIM, openDb, type Db } from '../src/shared/db.js';
import { countUnscored, createProject, listRanked, setManuscript, upsertPapers } from '../src/shared/repo.js';
import { scoreProject, type Embedder } from '../src/shared/scorer.js';

let db: Db;
const PROJ = 'p1';
const MODEL = 'test-model';

/** 語の集合から決定的にベクトルを作る。似た語を含むほど近くなる */
function fakeEmbedder(model = MODEL): Embedder {
  return {
    model,
    async embed(text: string) {
      const v = new Float32Array(EMBED_DIM);
      for (const w of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
        let h = 0;
        for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
        v[h % EMBED_DIM] += 1;
      }
      let n = 0;
      for (const x of v) n += x * x;
      n = Math.sqrt(n) || 1;
      for (let i = 0; i < v.length; i++) v[i] /= n;
      return v;
    },
  };
}

beforeEach(() => {
  db = openDb({ path: ':memory:' });
  createProject(db, {
    project_id: PROJ,
    title: 'GNN',
    summary: 'graph neural networks molecular property prediction transfer learning',
    embed_model: MODEL,
  });
});

afterEach(() => db.close());

const PAPERS = [
  { external_id: 'hit', source: 's', title: 'graph neural networks for molecular property prediction', abstract: 'transfer learning molecules' },
  { external_id: 'miss', source: 's', title: 'neural machine translation for low resource languages', abstract: 'translation corpora' },
];

describe('採点', () => {
  it('関連する論文が上位に来る', async () => {
    upsertPapers(db, PROJ, PAPERS);
    const n = await scoreProject(db, PROJ, fakeEmbedder());
    expect(n).toBe(2);

    const ranked = listRanked(db, PROJ);
    expect(ranked).toHaveLength(2);
    expect(ranked[0]!.title).toMatch(/molecular property prediction/);
    expect(ranked[0]!.relevance!).toBeGreaterThan(ranked[1]!.relevance!);
  });

  it('採点後は未採点が 0 になる', async () => {
    upsertPapers(db, PROJ, PAPERS);
    await scoreProject(db, PROJ, fakeEmbedder());
    expect(countUnscored(db, PROJ)).toBe(0);
  });

  it('主張があると最近傍のチャンクが併記される', async () => {
    setManuscript(db, PROJ, [
      { text: 'we pretrain a graph neural network on molecules' },
      { text: 'we translate between languages' },
    ]);
    upsertPapers(db, PROJ, PAPERS);
    await scoreProject(db, PROJ, fakeEmbedder());

    const ranked = listRanked(db, PROJ);
    const hit = ranked.find((r) => r.title.includes('molecular'))!;
    expect(hit.nearest_chunk_id).not.toBeNull();
    expect(hit.nearest_chunk_text).toMatch(/graph neural network/);
    expect(hit.nearest_chunk_sim).toBeGreaterThan(0);
  });

  it('主張が無くても採点できる（概要だけで決まる）', async () => {
    upsertPapers(db, PROJ, PAPERS);
    await scoreProject(db, PROJ, fakeEmbedder());
    const ranked = listRanked(db, PROJ);
    expect(ranked[0]!.nearest_chunk_id).toBeNull();
    // blend はチャンクが無ければ概要と一致する
    expect(ranked[0]!.relevance).toBeCloseTo(ranked[0]!.sim_summary!, 6);
  });
});

describe('中断と再開（NFR-06 / C-07）', () => {
  it('中断すると済んだ分だけ残り、残りは未採点のまま', async () => {
    upsertPapers(db, PROJ, [
      ...PAPERS,
      { external_id: 'x1', source: 's', title: 'x one', abstract: null },
      { external_id: 'x2', source: 's', title: 'x two', abstract: null },
    ]);

    const ac = new AbortController();
    let seen = 0;
    const done = await scoreProject(db, PROJ, fakeEmbedder(), {
      onProgress: () => {
        seen++;
        if (seen === 2) ac.abort();
      },
      signal: ac.signal,
    });

    expect(done).toBe(2);
    expect(countUnscored(db, PROJ)).toBe(2); // 残りは実数で分かる
    expect(listRanked(db, PROJ)).toHaveLength(2); // 済んだ分は見える
  });

  it('主張のベクトルが既にあっても再採点できる', async () => {
    setManuscript(db, PROJ, [{ text: 'we pretrain a graph neural network on molecules' }]);
    upsertPapers(db, PROJ, PAPERS);
    await scoreProject(db, PROJ, fakeEmbedder());
    expect(countUnscored(db, PROJ)).toBe(0);

    db.prepare("UPDATE papers SET scored_at = NULL WHERE project_id = ?").run(PROJ);
    const n = await scoreProject(db, PROJ, fakeEmbedder());
    expect(n).toBe(2);
    expect(countUnscored(db, PROJ)).toBe(0);
  });

  it('再開すると残りだけが採点される', async () => {
    upsertPapers(db, PROJ, PAPERS);
    const ac = new AbortController();
    await scoreProject(db, PROJ, fakeEmbedder(), {
      onProgress: () => ac.abort(),
      signal: ac.signal,
    });
    expect(countUnscored(db, PROJ)).toBe(1);

    const more = await scoreProject(db, PROJ, fakeEmbedder());
    expect(more).toBe(1);
    expect(countUnscored(db, PROJ)).toBe(0);
  });

  it('主張がある状態で中断しても再開できる', async () => {
    setManuscript(db, PROJ, [{ text: 'graph neural networks' }]);
    upsertPapers(db, PROJ, PAPERS);
    const ac = new AbortController();
    await scoreProject(db, PROJ, fakeEmbedder(), {
      onProgress: () => ac.abort(),
      signal: ac.signal,
    });
    expect(countUnscored(db, PROJ)).toBe(1);

    const more = await scoreProject(db, PROJ, fakeEmbedder());
    expect(more).toBe(1);
    expect(countUnscored(db, PROJ)).toBe(0);
  });

  it('進捗は実数で出る。推定しない', async () => {
    upsertPapers(db, PROJ, PAPERS);
    const seen: { done: number; total: number }[] = [];
    await scoreProject(db, PROJ, fakeEmbedder(), {
      onProgress: (p) => seen.push({ done: p.done, total: p.total }),
    });
    expect(seen).toEqual([
      { done: 1, total: 2 },
      { done: 2, total: 2 },
    ]);
  });
});

describe('モデルの取り違え', () => {
  it('プロジェクトと違うモデルでは採点させない', async () => {
    upsertPapers(db, PROJ, PAPERS);
    await expect(scoreProject(db, PROJ, fakeEmbedder('other-model'))).rejects.toThrow(
      /埋め込みモデルが違う/,
    );
    expect(countUnscored(db, PROJ)).toBe(2); // 何も採点されていない
  });

  it('存在しないプロジェクトは落とす', async () => {
    await expect(scoreProject(db, 'nope', fakeEmbedder())).rejects.toThrow(/プロジェクトが無い/);
  });
});
