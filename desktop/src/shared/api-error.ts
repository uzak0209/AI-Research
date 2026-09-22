/**
 * 失敗を利用者に見せる 1 行にする（C-07）。
 * オブジェクトを String() すると "[object Object]" になり、原因が消える。
 */

function asTrimmedString(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function formatIssues(issues: unknown): string | null {
  if (!Array.isArray(issues)) return null;
  const parts: string[] = [];
  for (const item of issues) {
    if (!item || typeof item !== 'object') continue;
    const o = item as { path?: unknown; message?: unknown };
    const msg = asTrimmedString(o.message);
    if (!msg) continue;
    const path = Array.isArray(o.path) ? o.path.filter((p) => typeof p === 'string' || typeof p === 'number').join('.') : '';
    parts.push(path ? `${path}: ${msg}` : msg);
  }
  return parts.length ? parts.join(' / ') : null;
}

/** Worker / OpenAPI の JSON 本文から 1 行。Zod の issues も読む。 */
export function describeApiError(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return asTrimmedString(body) ?? fallback;

  const o = body as Record<string, unknown>;
  const fromIssues =
    formatIssues(o.issues) ??
    (o.error && typeof o.error === 'object' ? formatIssues((o.error as { issues?: unknown }).issues) : null);
  if (fromIssues) return fromIssues;

  for (const key of ['detail', 'message', 'error'] as const) {
    const direct = asTrimmedString(o[key]);
    if (direct && direct !== '[object Object]') return direct;
    const nested = o[key];
    if (nested && typeof nested === 'object') {
      const inner =
        asTrimmedString((nested as Record<string, unknown>).message) ??
        asTrimmedString((nested as Record<string, unknown>).detail);
      if (inner && inner !== '[object Object]') return inner;
    }
  }
  return fallback;
}

/**
 * 例外を利用者に見せる 1 行。
 * Electron IPC は "Error invoking remote method 'x': Error: 本文" と包む。
 */
export function errorMessage(e: unknown): string {
  let raw = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  if (!raw && e && typeof e === 'object') {
    raw = describeApiError(e, '');
  }
  if (!raw || raw === '[object Object]') return '原因不明のエラー';
  raw = raw.replace(/^Error invoking remote method '[^']*':\s*/, '');
  raw = raw.replace(/^(?:Uncaught\s+)?(?:\w*Error):\s*/, '');
  raw = raw.trim();
  if (!raw || raw === '[object Object]') return '原因不明のエラー';
  return raw;
}
