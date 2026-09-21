# ADR 衛生スキャン

`.github/claude-scans/shared.md` を先に Read。

有効 ADR は **ちょうど 5 本**（0001〜0005）。6 本目の追加や、置き換え済みファイルの残存は問題。
設計の中身は design-review。主観的な「もっと詳しく」は出さない。

## 調べる対象

1. `docs/adr/` に README 以外で md が 5 本だけか。一覧・ルート README と一致するか
2. 相対リンク切れが無いか
3. 各 ADR にステータス・日付・決定があるか（短文形式でよい。コンテキスト／帰結の長文は不要）
4. 旧番号（0006 以降）や旧 `docs/requirements/` 分割への参照が残っていないか

## issue

`auto-scan,adr`。上限 3。引用必須。
