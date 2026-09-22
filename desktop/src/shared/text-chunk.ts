/** 段落〜数百トークン相当のチャンクに分ける（採点用。厳密なトークン数は取らない） */
export function chunkText(text: string, maxChars = 800): string[] {
  const cleaned = text.replace(/\r\n/g, '\n').trim();
  if (!cleaned) return [];

  const paras = cleaned
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const out: string[] = [];
  let buf = '';
  for (const p of paras) {
    if (p.length > maxChars) {
      if (buf) {
        out.push(buf);
        buf = '';
      }
      for (let i = 0; i < p.length; i += maxChars) {
        out.push(p.slice(i, i + maxChars));
      }
      continue;
    }
    if (!buf) {
      buf = p;
    } else if (buf.length + 1 + p.length <= maxChars) {
      buf = `${buf} ${p}`;
    } else {
      out.push(buf);
      buf = p;
    }
  }
  if (buf) out.push(buf);
  return out;
}
