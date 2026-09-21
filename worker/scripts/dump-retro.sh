#!/usr/bin/env bash
# D1 の集計だけを JSON に出す。本文・要旨・summary は出さない。
# Cloudflare のトークンは環境にある。標準出力にもログにも値を出さない（C-06）。
#
#   D1_TARGET=test|live|all LOOKBACK_DAYS=7 ./scripts/dump-retro.sh
#
# 出力先: tmp/d1-retro/<db>.json と tmp/d1-retro/index.json
# データベースが無い・認証が無いときは ok=false の JSON を書いて exit 0。
# Claude scan が「取れなかった」と降りるため（無い結果を失敗扱いにしない）。

set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${D1_TARGET:-live}"
DAYS="$(printf '%s' "${LOOKBACK_DAYS:-7}" | tr -cd '0-9')"
DAYS="${DAYS:-7}"
OUT="tmp/d1-retro"
mkdir -p "$OUT"
rm -f "$OUT"/*.json

case "$TARGET" in
  test) names="ai-research-test" ;;
  all)  names="ai-research-test ai-research-dev ai-research-prod" ;;
  live) names="ai-research-dev ai-research-prod" ;;
  *)
    echo "D1_TARGET must be test|live|all (got ${TARGET})" >&2
    exit 1
    ;;
esac

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  node --input-type=module -e '
    import { writeFileSync } from "node:fs";
    writeFileSync(process.argv[1], JSON.stringify({
      ok: false,
      reason: "CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID missing",
      target: process.argv[2],
      lookback_days: Number(process.argv[3]),
      databases: [],
    }, null, 2) + "\n");
  ' "$OUT/index.json" "$TARGET" "$DAYS"
  echo "wrote $OUT/index.json (credentials missing)"
  exit 0
fi

json_only() {
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const raw = readFileSync(0, "utf8");
    const start = raw.search(/[\[{]/);
    if (start < 0) {
      console.error("no JSON in wrangler output");
      process.exit(1);
    }
    process.stdout.write(raw.slice(start));
  '
}

query() {
  local db="$1" sql="$2"
  npx wrangler d1 execute "$db" --remote --json --command "$sql" | json_only
}

dump_one() {
  local db="$1"
  local file="$OUT/${db}.json"
  if ! npx wrangler d1 execute "$db" --remote --json --command "SELECT 1 AS ok" >/dev/null 2>"$OUT/${db}.err"; then
    node --input-type=module -e '
      import { readFileSync, writeFileSync } from "node:fs";
      let err = "";
      try { err = readFileSync(process.argv[2], "utf8").slice(0, 500); } catch {}
      writeFileSync(process.argv[1], JSON.stringify({
        ok: false,
        database: process.argv[3],
        reason: "d1 execute failed",
        error: err,
      }, null, 2) + "\n");
    ' "$file" "$OUT/${db}.err" "$db"
    rm -f "$OUT/${db}.err"
    echo "missing-or-failed ${db}"
    return 0
  fi
  rm -f "$OUT/${db}.err"

  local runs status papers usage span
  if ! runs="$(query "$db" "SELECT count(*) AS n FROM runs WHERE run_date >= date('now', '-${DAYS} day')")" \
     || ! status="$(query "$db" "SELECT status, count(*) AS n FROM runs WHERE run_date >= date('now', '-${DAYS} day') GROUP BY status")" \
     || ! papers="$(query "$db" "SELECT count(*) AS n FROM run_papers WHERE run_id IN (SELECT run_id FROM runs WHERE run_date >= date('now', '-${DAYS} day'))")" \
     || ! usage="$(query "$db" "SELECT endpoint, classification, count(*) AS rows, sum(calls) AS calls, sum(tokens) AS tokens FROM llm_usage WHERE usage_date >= date('now', '-${DAYS} day') GROUP BY endpoint, classification")" \
     || ! span="$(query "$db" "SELECT min(run_date) AS min_run_date, max(run_date) AS max_run_date FROM runs WHERE run_date >= date('now', '-${DAYS} day')")"; then
    node --input-type=module -e '
      import { writeFileSync } from "node:fs";
      writeFileSync(process.argv[1], JSON.stringify({
        ok: false,
        database: process.argv[2],
        reason: "aggregate query failed",
      }, null, 2) + "\n");
    ' "$file" "$db"
    echo "query-failed ${db}"
    return 0
  fi

  RUNS_JSON="$runs" STATUS_JSON="$status" PAPERS_JSON="$papers" USAGE_JSON="$usage" SPAN_JSON="$span" \
  node --input-type=module -e '
    import { writeFileSync } from "node:fs";
    const unwrap = (raw) => {
      const start = raw.search(/[\[{]/);
      const parsed = JSON.parse(start < 0 ? raw : raw.slice(start));
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      const first = rows[0] ?? {};
      return first.results ?? first.result ?? [];
    };
    const payload = {
      ok: true,
      database: process.argv[1],
      lookback_days: Number(process.argv[2]),
      fixture: process.argv[1] === "ai-research-test",
      runs: unwrap(process.env.RUNS_JSON)[0] ?? { n: 0 },
      runs_by_status: unwrap(process.env.STATUS_JSON),
      papers: unwrap(process.env.PAPERS_JSON)[0] ?? { n: 0 },
      llm_usage: unwrap(process.env.USAGE_JSON),
      span: unwrap(process.env.SPAN_JSON)[0] ?? { min_run_date: null, max_run_date: null },
    };
    writeFileSync(process.argv[3], JSON.stringify(payload, null, 2) + "\n");
  ' "$db" "$DAYS" "$file"
  echo "wrote ${file}"
}

dumped=""
for name in $names; do
  dump_one "$name"
  dumped="${dumped} ${name}"
done

node --input-type=module -e '
  import { readdirSync, readFileSync, writeFileSync } from "node:fs";
  const dir = process.argv[1];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json");
  const databases = files.map((f) => JSON.parse(readFileSync(`${dir}/${f}`, "utf8")));
  writeFileSync(`${dir}/index.json`, JSON.stringify({
    ok: databases.some((d) => d.ok),
    target: process.argv[2],
    lookback_days: Number(process.argv[3]),
    databases,
  }, null, 2) + "\n");
' "$OUT" "$TARGET" "$DAYS"

echo "wrote $OUT/index.json target=${TARGET} days=${DAYS}"
