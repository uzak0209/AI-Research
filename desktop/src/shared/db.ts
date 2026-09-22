// ローカルストア。GUI と CLI が共有する唯一のコア（FR-11。二重管理しない）。
//
// 実体は packages/core/src/store/db.ts。CLI（packages/cli）も同じ実装を使う。
// ここは Electron から既存の相対 import（'../shared/db.js'）を変えずに済ませるための再 export のみ。

export {
  EMBED_DIM,
  VectorExtensionError,
  openDb,
  toVectorBlob,
  cosine,
  type Db,
  type OpenOptions,
} from '@ai-research/core';
