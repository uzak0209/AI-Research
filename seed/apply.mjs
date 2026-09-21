#!/usr/bin/env node
/**
 * 機能紹介用 seed。catalog.json が正本。
 *
 *   node seed/apply.mjs --cloud-sql          # D1 用 SQL を stdout へ
 *   import { applyDesktopSeed } from './apply.mjs'
 *
 * seed- で始まる id だけを消して入れ直す。利用者の行は触らない。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(join(here, 'catalog.json'), 'utf8'));

const PROJECT = catalog.project.id;
const SOURCE = 'openalex';
const SCORED_AT = '2026-09-20 12:00:00';
const RUN_ID = 'seed-demo:2026-09-18';

const claimById = Object.fromEntries(catalog.claims.map((c) => [c.id, c]));
const paperById = Object.fromEntries(catalog.papers.map((p) => [p.id, p]));

function q(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** 空の自動生成プロジェクトか。NFC で比較する（macOS が NFD で持つことがある） */
export function isEmptyDefaultProject(row) {
  const title = String(row.title ?? '').normalize('NFC');
  const summary = String(row.summary ?? '').trim();
  return title === '新しいプロジェクト' && summary === '';
}

export function applyDesktopSeed(db) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM projects WHERE project_id = ?').run(PROJECT);

    db.prepare(
      `INSERT INTO projects (project_id, title, summary, embed_model, created_at)
       VALUES (?, ?, ?, ?, '2026-09-01 00:00:00')`,
    ).run(PROJECT, catalog.project.title, catalog.project.summary, catalog.project.embed_model);

    const docId = `${PROJECT}:manuscript`;
    db.prepare(
      `INSERT INTO documents (document_id, project_id, kind, format)
       VALUES (?, ?, 'manuscript', 'md')`,
    ).run(docId, PROJECT);

    const insChunk = db.prepare(
      'INSERT INTO chunks (chunk_id, document_id, section, text) VALUES (?, ?, ?, ?)',
    );
    for (const c of catalog.claims) {
      insChunk.run(c.chunk_id, docId, c.id, c.text);
    }

    const insPaper = db.prepare(
      `INSERT INTO papers (
         paper_id, project_id, run_id, external_id, source, title, abstract, url, published_at,
         coarse_score, relevance, sim_summary, nearest_chunk_id, nearest_chunk_sim,
         embed_model, scored_at, in_library
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const p of catalog.papers) {
      const scored = p.scored !== false;
      const nearest = p.nearest_claim ? claimById[p.nearest_claim] : null;
      insPaper.run(
        p.id,
        PROJECT,
        RUN_ID,
        p.external_id,
        SOURCE,
        p.title,
        p.abstract ?? null,
        p.url ?? null,
        p.published_at ?? null,
        p.coarse_score ?? null,
        scored ? p.relevance : null,
        scored ? p.sim_summary : null,
        scored && nearest ? nearest.chunk_id : null,
        scored ? (p.nearest_chunk_sim ?? null) : null,
        scored ? catalog.project.embed_model : null,
        scored ? SCORED_AT : null,
        p.in_library ? 1 : 0,
      );
    }

    const insTag = db.prepare('INSERT INTO tags (tag_id, project_id, name) VALUES (?, ?, ?)');
    for (const t of catalog.tags) insTag.run(t.id, PROJECT, t.name);

    const tagIdByName = Object.fromEntries(catalog.tags.map((t) => [t.name, t.id]));
    const insRef = db.prepare(
      `INSERT INTO reference_items (
         reference_id, project_id, paper_id, title, authors, year, doi, url, venue, abstract,
         item_type, starred, read_status, bibtex_key, added_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insRefTag = db.prepare('INSERT INTO reference_tags (reference_id, tag_id) VALUES (?, ?)');
    const insNote = db.prepare(
      "INSERT INTO notes (reference_id, body, updated_at) VALUES (?, ?, datetime('now'))",
    );

    for (const item of catalog.library) {
      const paper = item.paper_id ? paperById[item.paper_id] : null;
      const title = item.title ?? paper?.title;
      const authors = item.authors ?? paper?.authors ?? null;
      const year = item.year ?? paper?.year ?? null;
      const doi = item.doi ?? paper?.external_id ?? null;
      const url = item.url ?? paper?.url ?? null;
      const venue = item.venue ?? paper?.venue ?? null;
      const abstract = item.abstract ?? paper?.abstract ?? null;
      insRef.run(
        item.id,
        PROJECT,
        item.paper_id ?? null,
        title,
        authors,
        year,
        doi,
        url,
        venue,
        abstract,
        item.item_type ?? 'article',
        item.starred ? 1 : 0,
        item.read_status,
        item.bibtex_key,
        item.added_at,
        item.added_at,
      );
      for (const name of item.tags ?? []) {
        insRefTag.run(item.id, tagIdByName[name]);
      }
      if (item.note) insNote.run(item.id, item.note);
    }

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function cloudSeedSql() {
  const lines = [
    '-- 機能紹介用。user_id / project_id は seed-demo。利用者の行は消さない。',
    "DELETE FROM run_papers WHERE run_id LIKE 'seed-demo:%';",
    "DELETE FROM runs WHERE project_id = 'seed-demo';",
    "DELETE FROM llm_usage WHERE user_id = 'seed-demo';",
    "DELETE FROM projects WHERE project_id = 'seed-demo';",
    "DELETE FROM users WHERE user_id = 'seed-demo';",
    `INSERT INTO users (user_id, oauth_subject, created_at) VALUES ('seed-demo', 'google:seed-demo', '2026-09-01 00:00:00');`,
    `INSERT INTO projects (project_id, user_id, title, summary, created_at) VALUES (${q(PROJECT)}, 'seed-demo', ${q(catalog.project.title)}, ${q(catalog.project.summary)}, '2026-09-01 00:00:00');`,
  ];

  for (const run of catalog.runs) {
    lines.push(
      `INSERT INTO runs (run_id, project_id, run_date, status, failed_sources_json, created_at) VALUES (${q(run.run_id)}, ${q(PROJECT)}, ${q(run.run_date)}, ${q(run.status)}, ${q(run.failed_sources_json)}, ${q(run.run_date + ' 20:00:00')});`,
    );
    for (const paperId of run.papers) {
      const p = paperById[paperId];
      if (!p) throw new Error(`unknown paper in run: ${paperId}`);
      lines.push(
        `INSERT INTO run_papers (run_id, external_id, source, title, abstract, url, published_at, coarse_score) VALUES (${q(run.run_id)}, ${q(p.external_id)}, ${q(SOURCE)}, ${q(p.title)}, ${q(p.abstract ?? null)}, ${q(p.url ?? null)}, ${q(p.published_at ?? null)}, ${q(p.coarse_score ?? null)});`,
      );
    }
  }

  return lines.join('\n') + '\n';
}

if (process.argv.includes('--cloud-sql')) {
  process.stdout.write(cloudSeedSql());
}
