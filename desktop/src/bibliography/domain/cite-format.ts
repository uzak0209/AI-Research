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

/** マーカー内だけ差し替える。片方だけ残っていたら触らない（C-08） */
export function spliceManaged(source: string, inner: string, begin: string, end: string): string | null {
  const start = source.indexOf(begin);
  const stop = source.indexOf(end);
  if (start === -1 && stop === -1) {
    const pad = source.length === 0 || source.endsWith('\n') ? '' : '\n';
    return `${source}${pad}${begin}\n${inner}\n${end}\n`;
  }
  if (start === -1 || stop === -1 || stop < start) return null;
  return `${source.slice(0, start)}${begin}\n${inner}\n${source.slice(stop)}`;
}

export function citeInner(items: CiteItem[], format: CiteFormat): string {
  return format === 'hayagriva' ? renderHayagriva(items) : renderBibtex(items);
}

export function citeMarkers(format: CiteFormat): { begin: string; end: string } {
  return format === 'hayagriva'
    ? { begin: YML_BEGIN, end: YML_END }
    : { begin: BIB_BEGIN, end: BIB_END };
}
