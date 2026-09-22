import { REFRESH_KEY, type SettingsStore } from './settings.js';
import type { SecretBox } from './secret-box.js';

/**
 * メインプロセス / CLI が持つ。レンダラに渡さない（ADR-0001）。
 * access はメモリ、refresh は OS 保護領域経由で settings に残す。
 */
export class AuthSession {
  #access: string | null = null;

  constructor(
    private readonly settings: SettingsStore,
    private readonly box: SecretBox,
  ) {}

  getAccessToken(): string | null {
    return this.#access;
  }

  setAccessToken(token: string): void {
    this.#access = token;
  }

  getRefreshToken(): string | null {
    const row = this.settings.get(REFRESH_KEY);
    if (!row) return null;
    if (!row.encrypted) throw new Error('refresh が平文で保存されている');
    return this.box.decrypt(Buffer.from(row.value, 'base64'));
  }

  setRefreshToken(token: string): void {
    if (!this.box.isAvailable()) throw new Error('OS の保護領域が使えない');
    const enc = this.box.encrypt(token);
    this.settings.set(REFRESH_KEY, enc.toString('base64'), true);
  }

  clear(): void {
    this.#access = null;
    this.settings.delete(REFRESH_KEY);
  }
}
