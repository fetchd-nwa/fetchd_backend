#!/usr/bin/env bash
# `scripts/migrate-rehearse.sh [--base <git-ref>] [--leave-out <step_id>] [--plant-staff-row]`
# (`npm run migrate:rehearse -- …`) — rehearse a landing group's migration steps
# on a throwaway database and prove they produce exactly the schema of record.
# Design §4 preamble ("The rehearsal"), DECISIONS 51 and 52; S01.
#
# What it does, in order, in a throwaway `postgres:17` container:
#   1. loads `.claude/backend/00-supabase-roles.sql` (the API roles plain
#      Postgres lacks);
#   2. database `rehearsal`: loads the BASE ref's schema.sql
#      (`git show <base>:.claude/backend/schema.sql`) — the schema before the
#      group — then replays production's default privileges. Until the
#      production pg_default_acl reading exists (DECISIONS 51) that is
#      Supabase's stock grants: ALL on TABLES, SEQUENCES and FUNCTIONS in
#      `public`, for role postgres, to anon, authenticated and service_role;
#   3. applies every step file that is new since the base — `migrations/**/
#      <step_id>_*.sql` in the working tree, absent at the base — in step order,
#      each through `npm run migrate:apply` (`--project local`), so the bytes the
#      rehearsal sends are the bytes production will receive;
#   4. database `reference`: a fresh load of the WORKING TREE's schema.sql;
#   5. asserts the privileges (DECISIONS 68, 71): after the steps, `anon`,
#      `authenticated` and PUBLIC hold no privilege on any relation the group
#      created, neither API role can execute a function the group created, and
#      `pg_default_acl` for role postgres (in `public`, or global) grants them
#      nothing. Not vacuous: the stock grants replayed in step 2 must be visible
#      in pg_default_acl BEFORE the steps, or the rehearsal stops;
#   6. runs `scripts/db/fingerprint.sql` (a copy of
#      product/rebuild/phase-2/db/fingerprint.sql) against both and requires
#      0 differences. Any difference, failed assertion or failed step exits
#      non-zero.
#
# --base defaults to the newest `v1-lg*-close` tag (DECISIONS 52: today
# `v1-lg0-close`); never `main`, which moves only at milestone ends.
# --leave-out <step_id> skips one step: the instrument's own red proof (a
# rehearsal missing a step must report differences and exit 1).
# --plant-staff-row inserts ONE staff row into the production-shaped copy right
# after the base load: the red proof of M1.19's census gate (P02; design.md:
# 2122-2128). The run must then stop at M1.19 — the runner refuses the step
# because `staff` is not empty — and exit 1, with M1.18 and everything before
# it applied. The rehearsal never passes `--skip-census`: the gate binds here
# exactly as it binds production.
#
# Not part of `npm run gate`: it runs per landing group between GATE GREEN and
# merge. Needs Docker. What it cannot prove: seed rows (the fingerprint reads
# none); grants on the tables that predate the group (the base load carries
# none — production's 57 wait for its reading, DECISIONS 51/68); or that
# production's real default privileges match the stock ones replayed here.
# Removing one step's per-table REVOKE alone does NOT go red here, by design:
# M1.00's default-privilege revoke already keeps the stock grants off new
# tables, so the per-table REVOKE only matters if production's defaults are
# global — which is what the reading decides. That line is held instead by a
# static test over every step file (test/migrateRunner.test.ts, DECISIONS 71).
set -euo pipefail

cd "$(dirname "$0")/.." || exit 1

BASE=""
LEAVE_OUT=""
PLANT_STAFF_ROW=""
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="${2:?--base needs a git ref}"; shift 2 ;;
    --leave-out) LEAVE_OUT="${2:?--leave-out needs a step id}"; shift 2 ;;
    --plant-staff-row) PLANT_STAFF_ROW=1; shift ;;
    *) echo "migrate-rehearse: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

if [ -z "$BASE" ]; then
  BASE=$(git tag -l 'v1-lg*-close' --sort=-creatordate | head -n 1)
  if [ -z "$BASE" ]; then
    echo "migrate-rehearse: no v1-lg*-close tag to rehearse from; pass --base <ref>" >&2
    exit 2
  fi
fi
case "$BASE" in
  main | origin/main | refs/heads/main)
    echo "migrate-rehearse: --base is never main (DECISIONS 52): use the previous group's v1-lg*-close tag" >&2
    exit 2 ;;
esac
BASE_SHA=$(git rev-parse --verify --quiet "$BASE^{commit}") || {
  echo "migrate-rehearse: '$BASE' is not a commit" >&2
  exit 2
}

# The group's steps: every step file in the working tree that the base lacks,
# in step order (M<major>.<minor>, compared numerically).
STEPS=()
while IFS= read -r file; do
  [ -n "$file" ] && STEPS+=("$file")
done < <(
  comm -23 \
    <(find migrations -type f -name 'M*.sql' 2>/dev/null | sort) \
    <(git ls-tree -r --name-only "$BASE_SHA" -- migrations | sort) |
    awk -F/ '{ name=$NF; split(substr(name, 2), v, /[._]/); printf "%06d %06d %s\n", v[1], v[2], $0 }' |
    sort -k1,1n -k2,2n | cut -d' ' -f3-
)
if [ ${#STEPS[@]} -eq 0 ]; then
  echo "migrate-rehearse: no step files are new since $BASE — nothing to rehearse" >&2
  exit 1
fi
if [ -n "$LEAVE_OUT" ]; then
  KEPT=()
  for file in "${STEPS[@]}"; do
    case "$(basename "$file")" in "${LEAVE_OUT}"_*) ;; *) KEPT+=("$file") ;; esac
  done
  if [ ${#KEPT[@]} -eq ${#STEPS[@]} ]; then
    echo "migrate-rehearse: --leave-out $LEAVE_OUT names no step of this group" >&2
    exit 2
  fi
  STEPS=("${KEPT[@]}")
fi

CONTAINER="fetchd-rehearse-$$"
WORK=$(mktemp -d)
cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "migrate-rehearse: base $BASE ($BASE_SHA)"
echo "migrate-rehearse: ${#STEPS[@]} step(s)${LEAVE_OUT:+ (leaving out $LEAVE_OUT)}:"
printf '    %s\n' "${STEPS[@]}"

docker run -d --rm --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres -p 127.0.0.1::5432 postgres:17 >/dev/null
for _ in $(seq 1 120); do
  # 127.0.0.1, not the socket: the image's init server listens on the socket only.
  if docker exec "$CONTAINER" pg_isready -q -U postgres -h 127.0.0.1 2>/dev/null; then break; fi
  sleep 0.5
done
docker exec "$CONTAINER" pg_isready -q -U postgres -h 127.0.0.1 || {
  echo "migrate-rehearse: the throwaway postgres:17 never became ready" >&2
  exit 1
}
PORT=$(docker port "$CONTAINER" 5432/tcp | head -n 1 | sed 's/.*://')

psql_in() { docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$1"; }

psql_in postgres < .claude/backend/00-supabase-roles.sql
psql_in postgres <<< 'CREATE DATABASE rehearsal; CREATE DATABASE reference;'

echo "migrate-rehearse: rehearsal ← $BASE's schema.sql + Supabase's stock default grants"
git show "$BASE_SHA:.claude/backend/schema.sql" | psql_in rehearsal
psql_in rehearsal <<'SQL'
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
SQL

psql_value() { docker exec -i "$CONTAINER" psql -X -q -At -v ON_ERROR_STOP=1 -U postgres -d "$1"; }

if [ -n "$PLANT_STAFF_ROW" ]; then
  # A production that already holds a staffer: one row in the BASE's shape
  # ('trainer' is a value of both the old enum and the new one).
  psql_in rehearsal <<'SQL'
INSERT INTO staff (supabase_uid, name, role) VALUES (gen_random_uuid(), 'Census Probe', 'trainer');
SQL
  echo "migrate-rehearse: planted one staff row in the production-shaped copy — M1.19's census gate must stop the run"
fi

# The default grants to anon/authenticated that role postgres holds — in public,
# or global. Empty after the steps; NOT empty before them (else the check below
# proves nothing).
DEFAULT_GRANTS_SQL="SELECT coalesce(string_agg(DISTINCT d.defaclobjtype::text || ' to ' || a.grantee::regrole::text, ', '), '')
  FROM pg_default_acl d, aclexplode(d.defaclacl) a
 WHERE d.defaclrole = 'postgres'::regrole
   AND d.defaclnamespace IN (0, 'public'::regnamespace)
   AND a.grantee IN ('anon'::regrole, 'authenticated'::regrole)"
RELATIONS_SQL="SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p', 'v', 'm', 'S') ORDER BY 1"
# Functions by oid (signatures hold commas); the oids are stable within the database.
FUNCTIONS_SQL="SELECT oid FROM pg_proc WHERE pronamespace = 'public'::regnamespace ORDER BY 1"

REPLAYED=$(psql_value rehearsal <<< "$DEFAULT_GRANTS_SQL")
if [ -z "$REPLAYED" ]; then
  echo "migrate-rehearse: the stock default grants did not land — the privilege check would be vacuous" >&2
  exit 1
fi
psql_value rehearsal <<< "$RELATIONS_SQL" > "$WORK/relations-before.txt"
psql_value rehearsal <<< "$FUNCTIONS_SQL" | sort > "$WORK/functions-before.txt"

for file in "${STEPS[@]}"; do
  npm run --silent migrate:apply -- "$file" \
    --url "postgres://postgres:postgres@127.0.0.1:$PORT/rehearsal" --project local \
    --applied-by "migrate-rehearse" || {
    echo "migrate-rehearse: FAILED at $file — the group does not apply on $BASE" >&2
    exit 1
  }
done

# DECISIONS 68 and 71: nothing the group created is open to anon,
# authenticated or PUBLIC (which every role inherits; design.md:1620, 2189) —
# no relation, and no function (a new function is EXECUTE-able by PUBLIC unless
# its step revokes that) — and no default privilege would open the next thing.
psql_value rehearsal <<< "$RELATIONS_SQL" > "$WORK/relations-after.txt"
psql_value rehearsal <<< "$FUNCTIONS_SQL" | sort > "$WORK/functions-after.txt"
CREATED=$(comm -13 "$WORK/relations-before.txt" "$WORK/relations-after.txt" | paste -sd, -)
NEW_FUNCTIONS=$(comm -13 "$WORK/functions-before.txt" "$WORK/functions-after.txt" | paste -sd, -)
OPEN=""
if [ -n "$CREATED" ]; then
  OPEN=$(psql_value rehearsal <<< "SELECT coalesce(string_agg(DISTINCT c.relname || ' (' || a.privilege_type || ' to ' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END || ')', ', '), '')
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relname = ANY (string_to_array('$CREATED', ','))
       AND a.grantee IN ('anon'::regrole, 'authenticated'::regrole, 0)")
fi
CALLABLE=""
if [ -n "$NEW_FUNCTIONS" ]; then
  CALLABLE=$(psql_value rehearsal <<< "SELECT coalesce(string_agg(p.oid::regprocedure::text, ', '), '')
      FROM pg_proc p
     WHERE p.oid = ANY (string_to_array('$NEW_FUNCTIONS', ',')::oid[])
       AND (has_function_privilege('anon', p.oid, 'EXECUTE')
            OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))")
fi
LEFT=$(psql_value rehearsal <<< "$DEFAULT_GRANTS_SQL")
if [ -n "$OPEN" ] || [ -n "$CALLABLE" ] || [ -n "$LEFT" ]; then
  [ -n "$OPEN" ] && echo "migrate-rehearse: relations the group created are open to the API roles or PUBLIC: $OPEN" >&2
  [ -n "$CALLABLE" ] && echo "migrate-rehearse: functions the group created are executable by anon/authenticated (PUBLIC's default EXECUTE included): $CALLABLE" >&2
  [ -n "$LEFT" ] && echo "migrate-rehearse: default privileges for postgres still grant: $LEFT" >&2
  echo "migrate-rehearse: FAILED — the group leaves privileges for anon/authenticated/PUBLIC" >&2
  exit 1
fi
count() { printf '%s' "$1" | tr ',' '\n' | grep -c . || true; }
echo "migrate-rehearse: privileges — the stock grants ($REPLAYED) were replayed; after the steps no default grant to anon/authenticated remains, none of the $(count "$CREATED") relations the group created is open to anon, authenticated or PUBLIC, and none of the $(count "$NEW_FUNCTIONS") functions it created is executable by them"

echo "migrate-rehearse: reference ← the working tree's schema.sql"
psql_in reference < .claude/backend/schema.sql

fingerprint() {
  docker exec -i "$CONTAINER" psql -X -q -At -F $'\t' -v ON_ERROR_STOP=1 -U postgres -d "$1" \
    < scripts/db/fingerprint.sql > "$WORK/$1.tsv"
}
fingerprint rehearsal
fingerprint reference

DIFF=$(diff "$WORK/reference.tsv" "$WORK/rehearsal.tsv" || true)
COUNT=$(printf '%s\n' "$DIFF" | grep -c '^[<>]' || true)
OBJECTS=$(wc -l < "$WORK/reference.tsv" | tr -d ' ')
if [ "$COUNT" -ne 0 ]; then
  echo "migrate-rehearse: $COUNT fingerprint line(s) differ (< schema.sql of record, > base + steps):" >&2
  printf '%s\n' "$DIFF" | grep '^[<>]' | cut -f1-3 >&2
  echo "migrate-rehearse: FAILED — the steps do not produce the schema of record" >&2
  exit 1
fi
echo "migrate-rehearse: 0 differences across $OBJECTS fingerprinted objects — the steps produce the schema of record"
