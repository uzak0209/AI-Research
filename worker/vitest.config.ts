// Workers ランタイム上でテストする。Node で動かすと D1・KV・Queues の挙動がずれる。
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// 本番と同じマイグレーションをテスト用 D1 に当てる。
// スキーマをテスト側で二重に書かない（書くと本番とずれても気づけない）
const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        // テストから参照する。setup で適用する
        bindings: {
          TEST_MIGRATIONS: migrations,
          JWT_SIGNING_KEY: 'test-signing-key-at-least-32-chars',
        },
      },
      wrangler: { configPath: './wrangler.jsonc', environment: 'dev' },
    }),
  ],
  test: {
    setupFiles: ['./test/setup.ts'],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      reportsDirectory: './coverage',
    },
  },
});
