// 参考文献ライブラリの操作（FR-05 / FR-14）。
// 自分で保存し、読み、印を付け、メモを書ける。外部マネージャに依存しない（ADR-0003）。
//
// 実体は packages/core/src/store/library.ts。CLI（packages/cli）も同じ実装を使う（FR-11）。
// ここは Electron から既存の相対 import（'../shared/library.js'）を変えずに済ませるための再 export のみ。

export {
  type ReadStatus,
  type ReferenceInput,
  type ReferenceRow,
  type LibraryFilter,
  addReference,
  updateReference,
  deleteReference,
  setStarred,
  setReadStatus,
  addTag,
  removeTag,
  listTags,
  getNote,
  saveNote,
  findReferenceByDoi,
  findAttachmentByPath,
  addAttachment,
  listAttachments,
  removeAttachment,
  listReferences,
  getReference,
  libraryCounts,
} from '@ai-research/core';
