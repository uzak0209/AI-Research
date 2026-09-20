import type { CompiledQuery } from 'kysely';

/** Kysely が吐いた SQL を D1 の prepared statement にする */
export function toPrepared(d1: D1Database, compiled: CompiledQuery): D1PreparedStatement {
  const stmt = d1.prepare(compiled.sql);
  return compiled.parameters.length > 0 ? stmt.bind(...compiled.parameters) : stmt;
}

export async function execute<T>(d1: D1Database, compiled: CompiledQuery): Promise<T[]> {
  const { results } = await toPrepared(d1, compiled).all<T>();
  return results ?? [];
}

/** D1 は 1 実行 50 クエリまで。複数文は必ずここを通す */
export async function batch(d1: D1Database, compiled: CompiledQuery[]): Promise<void> {
  if (compiled.length === 0) return;
  await d1.batch(compiled.map((q) => toPrepared(d1, q)));
}
