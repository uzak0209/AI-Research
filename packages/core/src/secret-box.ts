/**
 * OS の保護領域。Electron では `safeStorage` を渡す（ADR-0001）。
 * テスト以外で平文ボックスを使わない。
 */
export interface SecretBox {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(encrypted: Buffer): string;
}

export function electronBox(safeStorage: {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}): SecretBox {
  return {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt(plain) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('OS の保護領域が使えない');
      }
      return safeStorage.encryptString(plain);
    },
    decrypt(encrypted) {
      return safeStorage.decryptString(encrypted);
    },
  };
}

/** テスト専用。本番の refresh をこれに通さない */
export function testBox(): SecretBox {
  return {
    isAvailable: () => true,
    encrypt: (plain) => Buffer.from(plain, 'utf8'),
    decrypt: (encrypted) => encrypted.toString('utf8'),
  };
}
