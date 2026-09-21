// ローカルストアの検証。重点は「欠損を成功と偽らない」こと（C-07）。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMBED_DIM, cosine, openDb, toVectorBlob, type Db } from '../src/shared/db.js';
import {
  addToLibrary,
  blendScore,
  countUnscored,
  countUnscoredMissingFulltext,
  createProject,
  listChunks,
  listLibrary,
  listRanked,
  listUnscored,
  makeBibtexKey,
  saveScore,
  getChunkEmbedding,
  setChunkEmbedding,
  setManuscript,
  setPaperFulltext,
  setProjectRoot,
  getProject,
  updateSummary,
  upsertPapers,
} from '../src/shared/repo.js';

let db: Db;
const PROJ = 'p1';

const unit = (i: number) => {
  const v = new Float32Array(EMBED_DIM);
  v[i % EMBED_DIM] = 1;
  return v;
};

beforeEach(() => {
  db = openDb({ path: ':memory:' });
  createProject(db, {
    project_id: PROJ,
    title: 'GNN for molecules',
    summary: 'graph neural networks for molecular property prediction',
    embed_model: 'Xenova/bge-small-en-v1.5',
  });
});

afterEach(() => db.close());

describe('スキーマと拡張', () => {
  it('sqlite-vec が読めて vec_chunks が作られる', () => {
    const r = db.prepare('SELECT vec_version() AS v').get() as { v: string };
    expect(r.v).toMatch(/^v\d/);
    const t = db
      .prepare("SELECT name FROM sqlite_master WHERE name = 'vec_chunks'")
      .get() as { name: string } | undefined;
    expect(t?.name).toBe('vec_chunks');
  });

  it('papers に有効／除外の列を持たない（ADR-0001）', () => {
    const cols = (db.prepare('PRAGMA table_info(papers)').all() as unknown as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).not.toContain('verdict');
    expect(cols).not.toContain('judgment');
    expect(cols).toContain('relevance');
    expect(cols).toContain('scored_at');
    expect(cols).toContain('authors');
  });

  it('次元の違うベクトルは黙って入らず落ちる', () => {
    expect(() => toVectorBlob(new Float32Array(10))).toThrow(/次元が違う/);
  });
});

describe('論文の取り込み', () => {
  const papers = [
    { external_id: 'doi:1', source: 'openalex', title: 'GNN for molecules', abstract: 'a' },
    { external_id: 'doi:2', source: 'openalex', title: 'Machine translation', abstract: 'b' },
  ];

  it('取り込むと未採点として数えられる', () => {
    expect(upsertPapers(db, PROJ, papers)).toBe(2);
    expect(countUnscored(db, PROJ)).toBe(2);
    expect(listRanked(db, PROJ)).toHaveLength(0); // 未採点は一覧に出さない
  });

  it('同じ論文を二度取り込んでも重複しない（同期は at-least-once）', () => {
    upsertPapers(db, PROJ, papers);
    expect(upsertPapers(db, PROJ, papers)).toBe(0);
    expect(countUnscored(db, PROJ)).toBe(2);
  });

  it('採点済みの論文を再取り込みしても採点を消さない', () => {
    upsertPapers(db, PROJ, papers);
    const [first] = listUnscored(db, PROJ);
    saveScore(db, first!.paper_id, {
      relevance: 0.8,
      sim_summary: 0.8,
      nearest_chunk_id: null,
      nearest_chunk_sim: null,
      embed_model: 'm',
    });
    upsertPapers(db, PROJ, papers);
    expect(countUnscored(db, PROJ)).toBe(1);
    expect(listRanked(db, PROJ)).toHaveLength(1);
  });

  it('既にある論文の空の authors だけ後から埋める', () => {
    upsertPapers(db, PROJ, [{ external_id: 'doi:1', source: 'openalex', title: 'GNN', abstract: 'a' }]);
    expect(
      upsertPapers(db, PROJ, [
        { external_id: 'doi:1', source: 'openalex', title: 'GNN', abstract: 'a', authors: 'Ada Lovelace' },
      ]),
    ).toBe(0);
    const row = db.prepare('SELECT authors FROM papers WHERE external_id = ?').get('doi:1') as { authors: string };
    expect(row.authors).toBe('Ada Lovelace');
  });
});

describe('採点（C-07）', () => {
  beforeEach(() => {
    upsertPapers(db, PROJ, [
      { external_id: 'a', source: 's', title: 'A', abstract: null },
      { external_id: 'b', source: 's', title: 'B', abstract: null },
      { external_id: 'c', source: 's', title: 'C', abstract: null },
    ]);
  });

  it('採点済みだけが関連度順に並ぶ。未採点は混ざらない', () => {
    const all = listUnscored(db, PROJ);
    saveScore(db, all[0]!.paper_id, { relevance: 0.5, sim_summary: 0.5, nearest_chunk_id: null, nearest_chunk_sim: null, embed_model: 'm' });
    saveScore(db, all[1]!.paper_id, { relevance: 0.9, sim_summary: 0.9, nearest_chunk_id: null, nearest_chunk_sim: null, embed_model: 'm' });

    const ranked = listRanked(db, PROJ);
    expect(ranked).toHaveLength(2);
    expect(ranked[0]!.relevance).toBe(0.9); // 降順
    expect(countUnscored(db, PROJ)).toBe(1); // 残りは実数で分かる
  });

  it('概要を変えると採点済みの印が落ちて採点し直しになる', () => {
    const all = listUnscored(db, PROJ);
    for (const p of all) {
      saveScore(db, p.paper_id, { relevance: 0.5, sim_summary: 0.5, nearest_chunk_id: null, nearest_chunk_sim: null, embed_model: 'm' });
    }
    expect(countUnscored(db, PROJ)).toBe(0);

    updateSummary(db, PROJ, '全く違う分野の概要');

    expect(countUnscored(db, PROJ)).toBe(3);
    expect(listRanked(db, PROJ)).toHaveLength(0); // 古い順位を見せ続けない
  });

  it('blend は概要 0.7 ＋ 最近傍チャンク 0.3', () => {
    expect(blendScore(1, 0)).toBeCloseTo(0.7, 6);
    expect(blendScore(0, 1)).toBeCloseTo(0.3, 6);
    // チャンクが無いときは概要だけで決める（0 で薄めない）
    expect(blendScore(0.8, null)).toBeCloseTo(0.8, 6);
  });
});

describe('自分の主張とベクトル検索', () => {
  it('主張を入れ替えると採点し直しになる', () => {
    upsertPapers(db, PROJ, [{ external_id: 'a', source: 's', title: 'A', abstract: null }]);
    const [p] = listUnscored(db, PROJ);
    saveScore(db, p!.paper_id, { relevance: 0.5, sim_summary: 0.5, nearest_chunk_id: null, nearest_chunk_sim: null, embed_model: 'm' });
    expect(countUnscored(db, PROJ)).toBe(0);

    setManuscript(db, PROJ, [{ text: 'We pretrain a GNN on molecules.' }]);
    expect(countUnscored(db, PROJ)).toBe(1);
  });

  it('主張の入れ替えで古いチャンクとベクトルが残らない', () => {
    const ids = setManuscript(db, PROJ, [{ text: 'old one' }, { text: 'old two' }]);
    for (const id of ids) setChunkEmbedding(db, id, unit(id));
    expect(listChunks(db, PROJ)).toHaveLength(2);

    const newIds = setManuscript(db, PROJ, [{ text: 'new only' }]);
    expect(listChunks(db, PROJ)).toHaveLength(1);

    // 消したチャンクのベクトルも消えている
    const left = db.prepare('SELECT COUNT(*) AS n FROM vec_chunks').get() as { n: number };
    expect(left.n).toBe(0);

    setChunkEmbedding(db, newIds[0]!, unit(1));
    const after = db.prepare('SELECT COUNT(*) AS n FROM vec_chunks').get() as { n: number };
    expect(after.n).toBe(1);
  });

  it('同じチャンクのベクトルを上書きできる（sqlite-vec は INSERT OR REPLACE 不可）', () => {
    const [id] = setManuscript(db, PROJ, [{ text: 'claim' }]);
    setChunkEmbedding(db, id!, unit(0));
    setChunkEmbedding(db, id!, unit(3));

    const stored = getChunkEmbedding(db, id!);
    expect(stored).not.toBeNull();
    expect(cosine(stored!, unit(3))).toBeCloseTo(1, 5);
    expect(cosine(stored!, unit(0))).toBeCloseTo(0, 5);

    const n = db.prepare('SELECT COUNT(*) AS n FROM vec_chunks').get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('sqlite-vec の KNN が最近傍を返す', () => {
    const ids = setManuscript(db, PROJ, [{ text: 'c0' }, { text: 'c1' }, { text: 'c2' }]);
    ids.forEach((id, i) => setChunkEmbedding(db, id, unit(i)));

    const q = toVectorBlob(unit(2));
    const rows = db
      .prepare('SELECT rowid, distance FROM vec_chunks WHERE embedding MATCH ? ORDER BY distance LIMIT 1')
      .all(q) as unknown as { rowid: number; distance: number }[];

    expect(Number(rows[0]!.rowid)).toBe(ids[2]);
    expect(rows[0]!.distance).toBeCloseTo(0, 5);
  });

  it('cosine は正規化済みベクトルで内積になる', () => {
    expect(cosine(unit(0), unit(0))).toBeCloseTo(1, 6);
    expect(cosine(unit(0), unit(1))).toBeCloseTo(0, 6);
  });
});

describe('ライブラリ（FR-05 / FR-12）', () => {
  it('bibtex_key は著者姓＋年で、衝突したら英字が付く', () => {
    expect(makeBibtexKey(db, PROJ, 'Jane Smith', 2024)).toBe('smith2024');
    addToLibrary(db, PROJ, { title: 'T1', authors: 'Jane Smith', year: 2024 });
    expect(makeBibtexKey(db, PROJ, 'John Smith', 2024)).toBe('smith2024a');
  });

  it('年が無くても key を作れる', () => {
    expect(makeBibtexKey(db, PROJ, 'Jane Smith', null)).toBe('smithnd');
  });

  it('候補から入れると論文側に印が付く', () => {
    upsertPapers(db, PROJ, [{ external_id: 'a', source: 's', title: 'A', abstract: null }]);
    const [p] = listUnscored(db, PROJ);
    saveScore(db, p!.paper_id, { relevance: 0.9, sim_summary: 0.9, nearest_chunk_id: null, nearest_chunk_sim: null, embed_model: 'm' });

    addToLibrary(db, PROJ, { paper_id: p!.paper_id, title: 'A', authors: 'Jane Smith', year: 2024 });

    expect(listRanked(db, PROJ)).toHaveLength(0);
    expect(listLibrary(db, PROJ)).toHaveLength(1);
  });

  it('本文が無い未採点を数える（mypaper 採点用）', () => {
    upsertPapers(db, PROJ, [
      { external_id: 'a', source: 's', title: 'A', abstract: null },
      { external_id: 'b', source: 's', title: 'B', abstract: null },
    ]);
    const rows = listUnscored(db, PROJ);
    setPaperFulltext(db, rows[0]!.paper_id, { path: 'x.pdf', text: 'body' });
    expect(countUnscoredMissingFulltext(db, PROJ)).toBe(1);
    expect(listUnscored(db, PROJ, 500, { requireFulltext: true })).toHaveLength(1);
  });

  it('同じ DOI は二重登録できない（ADR-0003）', () => {
    addToLibrary(db, PROJ, { title: 'T', authors: 'A B', year: 2024, doi: '10.1/x' });
    expect(() => addToLibrary(db, PROJ, { title: 'T dup', authors: 'C D', year: 2024, doi: '10.1/x' })).toThrow();
  });

  it('DOI が無い項目は複数入れられる', () => {
    addToLibrary(db, PROJ, { title: 'T1', authors: 'A B', year: 2024 });
    addToLibrary(db, PROJ, { title: 'T2', authors: 'C D', year: 2024 });
    expect(listLibrary(db, PROJ)).toHaveLength(2);
  });
});

describe('作業フォルダ', () => {
  it('root_path を後から付けられる', () => {
    expect(getProject(db, PROJ)?.root_path).toBeNull();
    setProjectRoot(db, PROJ, '/tmp/proj');
    expect(getProject(db, PROJ)?.root_path).toBe('/tmp/proj');
  });
});
