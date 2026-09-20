import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { builtinModules } from 'node:module';
import { resolve } from 'node:path';

// `electron` は devDependency なので externalizeDepsPlugin の対象外になる。
// 同梱すると npm パッケージ側（バイナリのパスを返すだけ）が読まれて
// "Electron failed to install correctly" で落ちる。明示的に外部化する。
const external = [
  'electron',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external,
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // utilityProcess から起動する採点ワーカー。別エントリにする
          'score-worker': resolve(__dirname, 'src/main/score-worker.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { external, input: resolve(__dirname, 'src/preload/index.ts') },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: { rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } },
  },
});
