import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { createRequire } from 'node:module';
import { builtinModules } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const pkg = require('./package.json') as { dependencies?: Record<string, string> };

// 外部化しないと何が壊れるか:
//
//   electron       devDependency なので externalizeDepsPlugin の対象外。
//                  同梱すると npm パッケージ側（バイナリのパスを返すだけ）が読まれて
//                  "Electron failed to install correctly" で落ちる
//   pdfjs-dist     ワーカーを自分のファイルからの相対パスで読むため、
//                  同梱すると "Cannot find module '.../pdf.worker.mjs'" で落ちる
//   sqlite-vec     ネイティブの拡張ファイルを同梱できない
//   @huggingface   onnxruntime のネイティブバインディングを同梱できない
//
// **`rollupOptions.external` を自分で書くと externalizeDepsPlugin の設定を上書きする。**
// そのため dependencies もここに並べる必要がある。
// サブパス import（例: 'pdfjs-dist/legacy/build/pdf.mjs'）もまとめて外部化する。
// パッケージ名だけを並べても、サブパスは一致せずバンドルされてしまう
const deps = ['electron', ...Object.keys(pkg.dependencies ?? {})];

// パッケージ名そのものと、その配下（`pdfjs-dist/legacy/build/pdf.mjs` など）の両方を外す。
// 正規表現の特殊文字はパッケージ名に出てこないので、そのまま組み立ててよい
const external: (string | RegExp)[] = [
  ...deps.map((d) => new RegExp('^' + d.replace(/[.+*?]/g, '\\$&') + '($|/)')),
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
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          // utilityProcess から起動する採点ワーカー。別エントリにする
          'score-worker': resolve(import.meta.dirname, 'src/main/score-worker.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { external, input: resolve(import.meta.dirname, 'src/preload/index.ts') },
    },
  },
  renderer: {
    // レンダラ側の pdfjs-dist は vite がバンドルする（?worker で別ファイルに出る）。
    // こちらは node_modules を参照できないので外部化しない
    root: resolve(import.meta.dirname, 'src/renderer'),
    build: { rollupOptions: { input: resolve(import.meta.dirname, 'src/renderer/index.html') } },
  },
});
