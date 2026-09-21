/** D1 に残す本人確認。メールや名前は持たない（ADR-0001） */
export function googleSubject(sub: string): string {
  return `google:${sub}`;
}

/**
 * Electron のループバックだけ許す。オープンリダイレクトにしない。
 * hostname は 127.0.0.1 のみ（localhost は名前解決で横取りされ得る）。
 */
export function isLoopbackRedirect(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:') return false;
  if (u.hostname !== '127.0.0.1') return false;
  if (u.username || u.password) return false;
  return true;
}
