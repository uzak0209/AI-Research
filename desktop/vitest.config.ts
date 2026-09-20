import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // node:sqlite と sqlite-vec を使うので Node 環境で走らせる
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
