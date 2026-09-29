import { describe, expect, it } from 'vitest';
import { EMBED_DIM, openDb } from '../src/shared/db.js';
import { createProject, setManuscript } from '../src/shared/repo.js';
import { searchLocal, type Embedder } from '../src/shared/scorer.js';

// 語ごとに軸を割り当てる決定的な埋め込み
const axes = ['graph', 'protein', 'market'];
const embedder: Embedder = {
  model: 'fake',
  async embed(text) {
    const v = new Float32Array(EMBED_DIM);
    axes.forEach((w, i) => {
      if (text.includes(w)) v[i] = 1;
    });
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  },
};

describe('searchLocal (FR-03)', () => {
  it('近い断片を順に返し、他プロジェクトは混ざらない', async () => {
    const db = openDb({ path: ':memory:' });
    const a = createProject(db, { title: 'a', summary: '', embed_model: 'fake' });
    const b = createProject(db, { title: 'b', summary: '', embed_model: 'fake' });
    setManuscript(db, a.project_id, [{ text: 'graph networks' }, { text: 'protein folding' }]);
    setManuscript(db, b.project_id, [{ text: 'graph other project' }]);
    const hits = await searchLocal(db, a.project_id, embedder, 'graph', 5);
    expect(hits.map((h) => h.text)).toEqual(['graph networks', 'protein folding']);
    expect(hits[0]!.score).toBeCloseTo(1, 3);
    expect(await searchLocal(db, a.project_id, embedder, '  ')).toEqual([]);
  });
});
