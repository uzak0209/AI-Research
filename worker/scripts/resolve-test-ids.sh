#!/usr/bin/env bash
# wrangler.jsonc の test 環境 ID を、このアカウント上の実リソースに差し替える。
# git の作業コピーを書き換える。CI の deploy-test がランナー上でだけ使う。
# ID は秘密ではない。値は標準出力に出してよい。
set -euo pipefail
cd "$(dirname "$0")/.."

json_field() {
  node --input-type=module -e '
    const fs = await import("fs");
    const raw = fs.readFileSync(0, "utf8");
    const start = raw.search(/[\[{]/);
    if (start < 0) {
      console.error("no JSON in wrangler output");
      process.exit(1);
    }
    const data = JSON.parse(raw.slice(start));
    const rows = Array.isArray(data) ? data : (data.result ?? data);
    const name = process.argv[1];
    const key = process.argv[2];
    const nameKeys = process.argv[3].split(",");
    const row = (Array.isArray(rows) ? rows : []).find((r) =>
      nameKeys.some((k) => r?.[k] === name)
    );
    if (!row || !row[key]) {
      console.error(`missing ${name} (${key})`);
      process.exit(1);
    }
    process.stdout.write(String(row[key]));
  ' "$@"
}

d1_id="$(npx wrangler d1 list --json | json_field ai-research-test uuid name)"
kv_id="$(npx wrangler kv namespace list | json_field IDEMPOTENCY_TEST id title,name)"

if [ -z "$d1_id" ] || [ -z "$kv_id" ]; then
  echo "test の D1 / KV が見つからない。先に scripts/bootstrap.sh test を走らせること。" >&2
  exit 1
fi

TEST_D1_ID="$d1_id" TEST_KV_ID="$kv_id" node --input-type=module -e '
  import { readFileSync, writeFileSync } from "node:fs";
  const d1 = process.env.TEST_D1_ID;
  const kv = process.env.TEST_KV_ID;
  let s = readFileSync("wrangler.jsonc", "utf8");
  const next = s
    .replace(
      /("database_name": "ai-research-test",\s*"database_id": ")[^"]+/,
      `$1${d1}`
    )
    .replace(
      /("name": "ai-research-api-test"[\s\S]*?"kv_namespaces": \[\{ "binding": "IDEMPOTENCY", "id": ")[^"]+/,
      `$1${kv}`
    );
  if (next === s) {
    console.error("wrangler.jsonc の test ブロックを書き換えられなかった");
    process.exit(1);
  }
  writeFileSync("wrangler.jsonc", next);
'

echo "test D1=${d1_id}"
echo "test KV=${kv_id}"
