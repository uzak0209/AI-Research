# リポジトリ規約

**設計フェーズ。** 勝手に実装を始めない。

| 置き場 | 内容 |
|---|---|
| [docs/requirements.md](docs/requirements.md) | 要件（1 本。成功条件・FR・C） |
| [docs/adr/](docs/adr/) | ADR（**3 本のみ**） |
| `prototypes/` | 検証用。本番ではない |

## 要件と ADR

- 何を = `docs/requirements.md` / どう = ADR-0001〜0003
- 4 本目の ADR・要件ファイルの分割を安易に増やさない
- 要件に無い機能を実装・ADR から生やさない
- 決定を覆すときは該当ファイルを改訂（無効コピーは残さない）

### 原則

1. `C-01` 未公開の恒久外部インデックス禁止（ADR-0001）
2. `C-04` 外部 LLM は分類統制下（ADR-0002）。埋め込み≠プロンプト
3. `C-06` 有料キーをクライアントに置かない（ADR-0002）
4. `C-08` ユーザーのファイルを壊さない。書き換えは自分のマーカー内のみ（ADR-0003）
5. 新機能は要件確認 → 分類（ADR-0002）→ endpoint

## ブランチ

`main` 直 push 禁止。feature → `dev`。`main` へは `dev` からのみ。

## public

未公開研究を issue/PR/コミットに書かない。`data/` `manuscripts/` `notes/` 等は `.gitignore` 済み。置き場追加はファイル前に ignore。

## 自動化 / コミット

`.github/claude-scans/`。コミットは `<type>: <要約>`＋なぜ。
