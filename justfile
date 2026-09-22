# ローカル検証。秘密は worker/.dev.vars（gitignore）。値を echo しない（C-06）。
# 未導入なら `brew install just`。

set shell := ["bash", "-cu"]
set dotenv-load := false

[private]
default:
    @just --list

# .dev.vars が無ければ example から作り、local D1 に migration を当てる。
# wrangler 用 API トークンは worker/.env（無ければ example）。値は出さない
[working-directory: 'worker']
env:
    bash scripts/local-env.sh

# wrangler が API トークンを読んでいるか。アカウント ID 以外の秘密は出さない
[working-directory: 'worker']
wrangler-whoami:
    npx wrangler whoami --env dev

# wrangler dev --env dev → http://127.0.0.1:8787
[working-directory: 'worker']
worker:
    npm run dev

# Electron。ELECTRON_RUN_AS_NODE を外す。API の既定は prod
[working-directory: 'desktop']
desktop:
    npm run dev

# ローカル Worker に書誌 BFF を叩く Electron。token は環境にだけ載せ、echo しない
desktop-cloud:
    #!/usr/bin/env bash
    set -euo pipefail
    export AI_RESEARCH_API=http://127.0.0.1:8787
    export AI_RESEARCH_ACCESS_TOKEN
    AI_RESEARCH_ACCESS_TOKEN="$(just token)"
    just desktop

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

[working-directory: 'packages/core']
test-core:
    npm test

[working-directory: 'packages/cli']
test-cli:
    npm test

test: test-worker test-desktop test-core test-cli

# CLI（FR-11）。GUI と同じローカルストアを操作する。dist/ が無ければ core を build する
[working-directory: 'packages/core']
cli-build:
    npm run build

# 例: `just cli project list` / `just cli -- lib add --title "..."`
[working-directory: 'packages/cli']
cli *args:
    node bin/ai-research.mjs {{args}}

# 機能紹介用。公開書誌だけ（C-01）。seed-demo のみ入れ直す
seed-desktop:
    node desktop/scripts/seed.mjs

# staging = Cloudflare D1 ai-research-dev。prod には当てない
[working-directory: 'worker']
seed-staging:
    bash scripts/seed.sh remote

[working-directory: 'worker']
seed-worker:
    bash scripts/seed.sh local
