# ローカル検証。秘密は worker/.dev.vars（gitignore）。値を echo しない（C-06）。
# 未導入なら `brew install just`。

set shell := ["bash", "-cu"]
set dotenv-load := false

[private]
default:
    @just --list

# .dev.vars が無ければ example から作り、local D1 に migration を当てる
[working-directory: 'worker']
env:
    bash scripts/local-env.sh

# wrangler dev --env dev → http://127.0.0.1:8787
[working-directory: 'worker']
worker:
    npm run dev

# Electron。ELECTRON_RUN_AS_NODE を外す
[working-directory: 'desktop']
desktop:
    npm run dev

# IdP 未決の間、curl 用 access JWT（署名鍵は出さない）
[working-directory: 'worker']
token:
    node scripts/mint-access.mjs

# worker が 8787 で動いている前提。/health と bibliography
[working-directory: 'worker']
verify:
    bash scripts/verify-local.sh

[working-directory: 'worker']
test-worker:
    npm test

[working-directory: 'desktop']
test-desktop:
    npm test

test: test-worker test-desktop
