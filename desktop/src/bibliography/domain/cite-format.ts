export const BIB_BEGIN = '% === ai-research:begin (do not edit) ===';
export const BIB_END = '% === ai-research:end ===';
export const YML_BEGIN = '# === ai-research:begin (do not edit) ===';
export const YML_END = '# === ai-research:end ===';

export type CiteFormat = 'bibtex' | 'hayagriva';

export type CiteItem = {
  bibtex_key: string;
  title: string;
  authors: string | null;
  year: number | null;
  doi: string | null;
  url: string | null;
  venue: string | null;
  item_type: string;
};

const BIB_TYPES = new Set(['article', 'inproceedings', 'book', 'phdthesis', 'misc']);

function bibtexEscape(s: string): string {
  return s.replace(/\\/g, '\\textbackslash{}').replace(/[{}]/g, '\\$&');
}

function yamlEscape(s: string): string {
  if (/[:#{}[\],&*?]|^\s|\s$/.test(s) || s === '') return JSON.stringify(s);
  return s;
}

function authorsBib(authors: string | null): string | null {
  if (!authors?.trim()) return null;
  return authors
    .split(/;/)
    .map((a) => a.trim())
    .filter(Boolean)
    .join(' and ');
}

function authorsYaml(authors: string | null): string[] {
  if (!authors?.trim()) return [];
  return authors
    .split(/;/)
    .map((a) => a.trim())
    .filter(Boolean);
}

export function renderBibtex(items: CiteItem[]): string {
  return items
    .map((it) => {
      const type = BIB_TYPES.has(it.item_type) ? it.item_type : 'misc';
      const lines = [`@${type}{${it.bibtex_key},`, `  title = {${bibtexEscape(it.title)}}`];
      const aut = authorsBib(it.authors);
      if (aut) lines.push(`  author = {${bibtexEscape(aut)}}`);
      if (it.year) lines.push(`  year = {${it.year}}`);
      if (it.venue) {
        const field = type === 'inproceedings' ? 'booktitle' : type === 'book' ? 'publisher' : 'journal';
        lines.push(`  ${field} = {${bibtexEscape(it.venue)}}`);
      }
      if (it.doi) lines.push(`  doi = {${bibtexEscape(it.doi)}}`);
      if (it.url) lines.push(`  url = {${bibtexEscape(it.url)}}`);
      lines.push('}');
      return lines.join('\n');
    })
    .join('\n\n');
}

export function renderHayagriva(items: CiteItem[]): string {
  const chunks: string[] = [];
  for (const it of items) {
    const type = BIB_TYPES.has(it.item_type) ? it.item_type : 'misc';
    const hayType = type === 'inproceedings' ? 'article' : type;
    const lines = [`${it.bibtex_key}:`, `  type: ${hayType}`, `  title: ${yamlEscape(it.title)}`];
    const aut = authorsYaml(it.authors);
    if (aut.length === 1) lines.push(`  author: ${yamlEscape(aut[0]!)}`);
    else if (aut.length > 1) {
      lines.push('  author:');
      for (const a of aut) lines.push(`    - ${yamlEscape(a)}`);
    }
    if (it.year) lines.push(`  date: ${it.year}`);
    if (it.doi) lines.push(`  doi: ${yamlEscape(it.doi)}`);
    if (it.url) lines.push(`  url: ${yamlEscape(it.url)}`);
    if (it.venue) {
      lines.push('  parent:');
      lines.push(`    type: ${type === 'inproceedings' ? 'proceedings' : 'periodical'}`);
      lines.push(`    title: ${yamlEscape(it.venue)}`);
    }
    chunks.push(lines.join('\n'));
  }
  return chunks.join('\n');
}

/**
 * 内容比較用の簡易ハッシュ（暗号目的ではない。マーカー内の手編集の有無だけを見る）。
 * 前回書き出した inner の文字列と今回の inner・マーカー間の実文字列を比べるためだけに使う。
 */
export function hashInner(inner: string): string {
  let h1 = 0xdeadbeef ^ inner.length;
  let h2 = 0x41c6ce57 ^ inner.length;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

export type SpliceDecision =
  | { status: 'create' | 'update'; next: string; hash: string }
  /** マーカーごと消されていた。追跡は諦める。復元しない（ADR-0003 却下事項） */
  | { status: 'skip_removed' }
  /** 片方だけ残っている。壊れているので触らない */
  | { status: 'skip_broken' }
  /** マーカー内が前回書き出し分と食い違う＝手編集。上書きせず警告して終わる */
  | { status: 'skip_conflict' };

/**
 * マーカー内だけ差し替える計画を立てる（純粋関数。I/O はしない）。
 *
 * `lastHash` は前回このマーカーに書き出した inner のハッシュ。
 * - マーカーが両方無い場合: `lastHash` が有れば「消された」= 何もしない。無ければ初回書き出し
 * - マーカーが両方ある場合: マーカー内の現在の文字列のハッシュが `lastHash` と食い違えば手編集とみなす
 */
export function planSplice(
  source: string,
  inner: string,
  begin: string,
  end: string,
  lastHash: string | null,
): SpliceDecision {
  const start = source.indexOf(begin);
  const stop = source.indexOf(end);

  if (start === -1 && stop === -1) {
    if (lastHash !== null) return { status: 'skip_removed' };
    const pad = source.length === 0 || source.endsWith('\n') ? '' : '\n';
    return { status: 'create', next: `${source}${pad}${begin}\n${inner}\n${end}\n`, hash: hashInner(inner) };
  }
  if (start === -1 || stop === -1 || stop < start) return { status: 'skip_broken' };

  let current = source.slice(start + begin.length, stop);
  if (current.startsWith('\n')) current = current.slice(1);
  if (current.endsWith('\n')) current = current.slice(0, -1);
  if (lastHash !== null && hashInner(current) !== lastHash) return { status: 'skip_conflict' };

  return {
    status: 'update',
    next: `${source.slice(0, start)}${begin}\n${inner}\n${source.slice(stop)}`,
    hash: hashInner(inner),
  };
}

export function citeInner(items: CiteItem[], format: CiteFormat): string {
  return format === 'hayagriva' ? renderHayagriva(items) : renderBibtex(items);
}

export function citeMarkers(format: CiteFormat): { begin: string; end: string } {
  return format === 'hayagriva'
    ? { begin: YML_BEGIN, end: YML_END }
    : { begin: BIB_BEGIN, end: BIB_END };
}
