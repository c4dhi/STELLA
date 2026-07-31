#!/usr/bin/env bash
#
# Full-fidelity backup round-trip test (#378).
#
# Proves that a backup transfers ALL information exactly: it stands up a
# throwaway Postgres, applies the real Prisma migrations to a source and two
# target databases, seeds the source with adversarial data (a table that
# crosses the export chunk boundary, int8 values beyond JS's safe-integer range,
# microsecond timestamps, unicode/emoji/quote/backslash text, and NULLs), then:
#
#   1. exports the source with the real in-pod CLI,
#   2. imports into target #1 and content-hashes every table vs. the source,
#   3. runs the host encrypt -> decrypt path (config embed + AES-256-GCM),
#      imports the recovered bundle into target #2, and content-hashes again,
#   4. checks the agent-package tree is byte-identical and a wrong passphrase
#      fails closed.
#
# Order-independent md5 of `(row)::text` per table is the equality oracle:
# identical hashes mean byte-identical content (every column, every type).
#
# Requires: docker, npx/node, a built dist (`npm run build`). Touches nothing
# outside its own container and /tmp; cleans up on exit.
#
#   ./scripts/backup-roundtrip-test.sh
#
set -euo pipefail

CONTAINER=stella-bktest-$$
PORT=55433
WORK="$(mktemp -d)"
PW=test
CLI=dist/src/backup/backup.cli.js

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; rm -rf "$WORK" 2>/dev/null || true; }
trap cleanup EXIT

psql_db() { docker exec "$CONTAINER" psql -U postgres -d "$1" -tAc "$2"; }
url() { echo "postgresql://postgres:${PW}@localhost:${PORT}/$1"; }

# md5 of every row's full text form, order-independent — the equality oracle.
table_hash() {
  psql_db "$1" "SELECT md5(coalesce(string_agg(x.r, E'\n' ORDER BY x.r), '')) \
                FROM (SELECT (t.*)::text AS r FROM \"$2\" t) x;"
}

compare_all() { # <srcDb> <otherDb>
  local tables mism=0
  tables=$(psql_db "$1" "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' ORDER BY tablename;")
  while IFS= read -r t; do
    [[ -z "$t" ]] && continue
    if [[ "$(table_hash "$1" "$t")" != "$(table_hash "$2" "$t")" ]]; then
      echo "  MISMATCH: $t"; mism=$((mism + 1))
    fi
  done <<< "$tables"
  echo "$mism"
}

[[ -f "$CLI" ]] || { echo "Build first: npm run build"; exit 1; }

echo "==> Starting throwaway Postgres ($CONTAINER on :$PORT)"
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD="$PW" -p "$PORT:5432" postgres:16 >/dev/null
for _ in $(seq 1 30); do docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done

for db in src dst dst2; do
  psql_db postgres "CREATE DATABASE $db;" >/dev/null
  DATABASE_URL="$(url "$db")" npx prisma migrate deploy >/dev/null 2>&1
done
echo "==> Migrated src, dst, dst2"

echo "==> Seeding adversarial data into src"
psql_db src "
INSERT INTO \"User\" (id,email,password,name,\"createdAt\",\"updatedAt\",verified,\"isSystemAdmin\")
SELECT 'u'||g,'user'||g||'@ex.com','pw'||g,
       CASE WHEN g%7=0 THEN NULL ELSE 'Name '||g END,
       '2026-01-01'::timestamp + (g||' seconds')::interval,'2026-01-01'::timestamp,(g%2=0),false
FROM generate_series(1,1500) g;
INSERT INTO \"User\"(id,email,password,name,\"createdAt\",\"updatedAt\",verified,\"isSystemAdmin\") VALUES
 ('u-uni','uni@ex.com','p','Ünïcödé 日本語 🎉 \"q\" \ b','2026-03-14 15:09:26.535897','2026-03-14 15:09:26.535897',true,true),
 ('u-null','null@ex.com','p',NULL,'2026-02-02 02:02:02.000123','2026-02-02 02:02:02',false,false);
INSERT INTO \"ServerMetricsSnapshot\"(id,timestamp,\"cpuUsage\",\"memoryTotal\",\"memoryUsed\",\"memoryFree\",\"gpuAvailable\",\"k8sMemoryUsed\") VALUES
 ('m-big','2026-04-01 12:00:00.123456',0.333333,9007199254740993,9007199254740992,-1,false,9223372036854775807);
" >/dev/null

mkdir -p "$WORK/pkgsrc/sub" "$WORK/pkgdst" "$WORK/pkgdst2"
printf 'agent-one\x00\x01\x02' > "$WORK/pkgsrc/agent1.zip"
echo "nested" > "$WORK/pkgsrc/sub/agent2.txt"

echo "==> [1] Export src -> import dst (plain)"
DATABASE_URL="$(url src)" AGENT_STORAGE_PATH="$WORK/pkgsrc" node "$CLI" export --out "$WORK/b.zip" --include-metrics >/dev/null 2>&1
cp "$WORK/b.zip" "$WORK/b-keep.zip" # import deletes its input (credential), keep a copy for step 2
DATABASE_URL="$(url dst)" AGENT_STORAGE_PATH="$WORK/pkgdst" node "$CLI" import --in "$WORK/b.zip" --confirm >/dev/null 2>&1
m1=$(compare_all src dst)
diff -r "$WORK/pkgsrc" "$WORK/pkgdst" >/dev/null && p1=IDENTICAL || p1=DIFF

echo "==> [2] Host encrypt -> decrypt -> import dst2"
printf 'ENV_VAR_ENCRYPTION_KEY=deadbeef\nJWT_SECRET=s3cr3t\n' > "$WORK/deploy.env"
BACKUP_PASSPHRASE='pass phrase 123' npx ts-node scripts/backup-bundle.ts finalize "$WORK/b-keep.zip" "$WORK/deploy.env" "$WORK/final.enc" >/dev/null 2>&1
[[ "$(head -c 9 "$WORK/final.enc")" == "STELLABK2" ]] && enc=OK || enc=BAD
BACKUP_PASSPHRASE='pass phrase 123' npx ts-node scripts/backup-bundle.ts prepare-restore "$WORK/final.enc" "$WORK/rec.zip" "$WORK/rec.env" >/dev/null 2>&1
diff -q "$WORK/deploy.env" "$WORK/rec.env" >/dev/null && cfg=IDENTICAL || cfg=DIFF
if BACKUP_PASSPHRASE='WRONG' npx ts-node scripts/backup-bundle.ts prepare-restore "$WORK/final.enc" "$WORK/x.zip" "$WORK/x.env" >/dev/null 2>&1; then wrongpw=ACCEPTED; else wrongpw=REJECTED; fi
DATABASE_URL="$(url dst2)" AGENT_STORAGE_PATH="$WORK/pkgdst2" node "$CLI" import --in "$WORK/rec.zip" --confirm >/dev/null 2>&1
m2=$(compare_all src dst2)
diff -r "$WORK/pkgsrc" "$WORK/pkgdst2" >/dev/null && p2=IDENTICAL || p2=DIFF

echo "==> [3] Plaintext-config guard (#380)"
# The guard that makes encryption the default lives in finalize(). Steps 1-2
# always supply a passphrase, so without these three checks the refusal could be
# inverted and nothing would fail.
if BACKUP_PASSPHRASE='' npx ts-node scripts/backup-bundle.ts finalize \
      "$WORK/b-keep.zip" "$WORK/deploy.env" "$WORK/refused.zip" >/dev/null 2>&1; then
  guard=ACCEPTED           # refusal did not fire — the control is broken
else
  guard=REFUSED
fi
# A refusal must also leave nothing behind: a partially-written bundle would
# still be a plaintext credential on disk.
[[ -e "$WORK/refused.zip" ]] && guard_file=WROTE_FILE || guard_file=NO_FILE
# The documented escape hatch must still work, or operators will reach for
# something worse.
if BACKUP_PASSPHRASE='' STELLA_ALLOW_PLAINTEXT_CONFIG=1 npx ts-node scripts/backup-bundle.ts finalize \
      "$WORK/b-keep.zip" "$WORK/deploy.env" "$WORK/override.zip" >/dev/null 2>&1 \
      && [[ -s "$WORK/override.zip" ]]; then
  guard_override=OK
else
  guard_override=BROKEN
fi

echo "==> [4] Staged plaintext is not world-readable (#380)"
# The encrypted bundle and the recovered .env both hold secrets; on a shared
# host, mode 0644 exposes them to every local user for the export window.
perms_enc="$(stat -f '%Lp' "$WORK/final.enc" 2>/dev/null || stat -c '%a' "$WORK/final.enc" 2>/dev/null)"
perms_env="$(stat -f '%Lp' "$WORK/rec.env" 2>/dev/null || stat -c '%a' "$WORK/rec.env" 2>/dev/null)"
[[ "$perms_enc" == "600" && "$perms_env" == "600" ]] && modes=OK || modes="BAD(enc=$perms_enc env=$perms_env)"

echo
echo "================ RESULTS ================"
echo "  [plain]     table mismatches: $m1   packages: $p1"
echo "  [encrypted] table mismatches: $m2   packages: $p2"
echo "  encryption marker: $enc   config round-trip: $cfg   wrong passphrase: $wrongpw"
echo "  plaintext guard: $guard   wrote file on refusal: $guard_file   override: $guard_override"
echo "  staged file modes: $modes"
echo "========================================="
if [[ "$m1" == 0 && "$m2" == 0 && "$p1" == IDENTICAL && "$p2" == IDENTICAL \
      && "$enc" == OK && "$cfg" == IDENTICAL && "$wrongpw" == REJECTED \
      && "$guard" == REFUSED && "$guard_file" == NO_FILE && "$guard_override" == OK \
      && "$modes" == OK ]]; then
  echo "PASS — all information transferred exactly, and the secret guards hold."
else
  echo "FAIL — see mismatches above."; exit 1
fi
