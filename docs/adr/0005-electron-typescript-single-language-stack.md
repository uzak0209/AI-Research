# ADR-0005: Electron + TypeScript で統一し、Python を必須依存にしない

- **ステータス**: 承認済み
- **日付**: 2026-09-19

## コンテキスト

デスクトップが担う成功条件（2〜4, 6）とローカル埋め込み（ADR-0003）を、
配布可能な一つのアプリに載せる（`NFR-05`）。Tauri / Electron / Python GUI を比較した。
Node でローカル埋め込みは可能（Transformers.js）という前提で選ぶ。

当初の見立てでは「ローカル埋め込み推論には Python か Rust の推論環境が必要」と考えていた。これは**誤り**だった。Node でローカル埋め込みは問題なく実行できる。

- **Transformers.js (`@huggingface/transformers`)** — HuggingFace 公式の JS 実装。内部は ONNX Runtime。`pipeline('feature-extraction', ...)` で数行で埋め込みが得られる
- **`onnxruntime-node`** — Node 環境ではこれが使われ、CPU でもマルチスレッドで実用速度が出る
- **WebGPU** — Electron のレンダラプロセスは Chromium なので WebGPU が使える。Apple Silicon の GPU が効いて CPU 実行より数倍速い。Node のメインプロセス単体では使えない
- **LanceDB** — `@lancedb/lancedb` に Node ネイティブバインディングがある。実装は Rust だが `npm install` だけで入る

この事実によって、Tauri の主要な利点（Rust 製 LanceDB との親和性、推論環境）が消え、逆に WebGPU が使える点で Electron が優位になった。

クラウド側 (ADR-0002) は Cloudflare Workers であり TypeScript である。デスクトップも TypeScript にすれば、型定義・D1 スキーマ・レポートのデータ構造を両者で共有できる。

## 決定

**Electron + TypeScript を採用する。**

- メインプロセス: D1 同期、Zotero 連携、ファイル監視、LanceDB アクセス
- レンダラプロセス: UI、および **Transformers.js による埋め込み推論を WebGPU で実行**
- ベクトル DB: LanceDB (Node バインディング)
- 共有コード: D1 スキーマ、レポート型、スコアリングの型定義を Workers とデスクトップで共有するパッケージに切り出す

**Python を実行時の必須依存にしない。** 埋め込み推論・ベクトル検索・論文取得のすべてを Node で完結させる。

例外として、ONNX 未公開モデルを使う場合の**ビルド時ツール**としての Python は許容する (ADR-0006 参照)。この場合も生成された ONNX ファイルを成果物としてコミット/配布し、エンドユーザーの環境に Python を要求しない。

## 検討した代替案

**Tauri (Rust)** — バンドルサイズが小さく省メモリ。しかし LanceDB の Node バインディングが存在するため親和性の利点が消え、WebGPU による推論高速化が使えない。Rust の学習コストも加わる。却下。

**Python + PySide/Flet** — RAG ライブラリ (LangChain, LlamaIndex, sentence-transformers) が最も充実している。しかしクラウド側と言語が分かれ、デスクトップアプリとしての配布が最も面倒（PyInstaller 等の同梱と署名）。却下。

**Electron のメインプロセスで推論する** — 実装は単純だが WebGPU が使えず CPU 実行に落ちる。レンダラ側で実行し IPC で結果を渡す構成を選ぶ。

## 帰結

**良い点**

- クラウドとデスクトップで言語が統一され、型とスキーマを共有できる
- WebGPU により Apple Silicon の GPU で埋め込み推論が高速化する
- Python が不要なため配布とセットアップが単純になる
- Transformers.js と LanceDB の両方が `npm install` で揃う

**悪い点**

- バンドルサイズが 150MB 程度になる。ただし埋め込みモデル自体が数百MB〜1GB あるため相対的な影響は小さい
- Electron のメモリ消費は Tauri より大きい
- 推論をレンダラで行うため、メインプロセスとの IPC 設計が必要になる。大量のベクトルを IPC で流すとコストになるので、ベクトルはレンダラ側で生成してから LanceDB への書き込みをまとめて依頼する等の設計が要る
- WebGPU が利用できない環境へのフォールバック (CPU 実行) を用意する必要がある

## 参考

- ADR-0003: ローカル完結 RAG
- ADR-0006: 埋め込みベクトル空間の分離
