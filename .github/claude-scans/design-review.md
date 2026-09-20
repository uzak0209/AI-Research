# 設計レビュースキャン

`.github/claude-scans/shared.md` を先に Read して従え。

有効 ADR は **0001 / 0002 / 0003**。要件は `docs/requirements.md` 1 本。
書式は adr-hygiene、外部動向は research-trend。

## 調べる対象

1. **3 本の間の矛盾**（例: 0001 のローカル RAG と 0002 の外部 LLM の境界が崩れていないか）
2. **抜け**: 同期の冪等性、欠損と成功の区別、新機能の C1/C2/C3 未割当、BFF が自由プロキシ化していないか、C3 の FB 無効と同意
3. **README・要件 (`docs/requirements.md`)・ER 図 (`docs/er-diagram.md`)・ADR の食い違い**
4. **`.gitignore`** が未公開データ置き場を守れているか
5. **`C-08`**: ユーザーのファイルへの書き込みがマーカー内に限定されているか。
   全体上書き・マーカー外の書き換え・消されたマーカーの自動復元を求める記述が無いか

既知で問題にしないこと: 埋め込みローカル vs プロンプト外部（意図的非対称）。

## issue

通ったものだけ `auto-scan,design`。タイトルに ADR 番号。引用必須。
