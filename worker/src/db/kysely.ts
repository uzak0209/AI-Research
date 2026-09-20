import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from 'kysely';
import type { DB } from './types';

/**
 * SQL を組み立てるだけ。実行は D1（`execute.ts`）。
 * kysely-d1 は 1 クエリずつ .execute() するだけで batch が無いので使わない。
 */
export const db = new Kysely<DB>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (d) => new SqliteIntrospector(d),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});
