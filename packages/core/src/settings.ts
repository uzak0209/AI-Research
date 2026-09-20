export const REFRESH_KEY = 'auth.refresh_token_enc';

export interface SettingRow {
  key: string;
  value: string;
  encrypted: boolean;
}

export interface SettingsStore {
  get(key: string): SettingRow | null;
  set(key: string, value: string, encrypted: boolean): void;
  delete(key: string): void;
}

type SqliteDb = {
  exec(sql: string): unknown;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
};

/**
 * ローカル SQLite の `settings`。秘密の値は既に暗号化済みの文字列を入れる。
 * DB ファイル自体は暗号化しない（ADR-0001）。
 */
export function createSettingsStore(db: SqliteDb): SettingsStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      encrypted INTEGER NOT NULL DEFAULT 0
    )
  `);

  const getStmt = db.prepare('SELECT key, value, encrypted FROM settings WHERE key = ?');
  const setStmt = db.prepare(
    'INSERT INTO settings (key, value, encrypted) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, encrypted = excluded.encrypted',
  );
  const delStmt = db.prepare('DELETE FROM settings WHERE key = ?');

  return {
    get(key) {
      const row = getStmt.get(key) as { key: string; value: string; encrypted: number } | undefined;
      if (!row) return null;
      return { key: row.key, value: row.value, encrypted: row.encrypted === 1 };
    },
    set(key, value, encrypted) {
      setStmt.run(key, value, encrypted ? 1 : 0);
    },
    delete(key) {
      delStmt.run(key);
    },
  };
}
