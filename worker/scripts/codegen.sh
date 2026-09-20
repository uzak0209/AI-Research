#!/usr/bin/env bash
# migrations を local D1 に当ててから、kysely-codegen で src/db/types.ts を作り直す。
set -euo pipefail
cd "$(dirname "$0")/.."

npx wrangler d1 migrations apply ai-research-dev --local --env dev

db="$(find .wrangler/state -name '*.sqlite' -print0 2>/dev/null | xargs -0 ls -t 2>/dev/null | head -1 || true)"
if [ -z "${db:-}" ]; then
  echo "local D1 の sqlite が見つからない。" >&2
  exit 1
fi

npx kysely-codegen --dialect sqlite --url "$db" --out-file src/db/types.ts
echo "wrote src/db/types.ts from $db"
