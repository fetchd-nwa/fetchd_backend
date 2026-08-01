#!/usr/bin/env bash
# `npm run gate` — the WHOLE backend gate, in one command, with no way to report
# a partial green.
#
# WHY THIS EXISTS. The gate was a four-item list in CLAUDE.md that each session
# ran by hand. Two branches — `notifications-phase-1` and mobile `main` — shipped
# labelled "known-green" while FAILING lint, because whoever ran them ran three
# of the four and reported the result as if it were all four. A checklist in
# prose is not a gate; it is a proxy for a gate that happens to be right most of
# the time.
#
# Three properties this has and a hand-run sequence doesn't:
#
#   1. It runs EVERY step even after one fails. `a && b && c` stops at the first
#      failure, so you learn about lint and never learn about the suite — which
#      is how a branch acquires two problems and a report mentioning one.
#   2. It reads `# pass` / `# fail` / `# skipped` out of the suite, not just the
#      exit code. A run that silently skipped every DB test exits 0. That has
#      happened here (`SKIP_WHEN_NO_DB` misused as `{ skip: ... }` skips forever
#      while reporting green).
#   3. It prints one summary you can paste. If any step failed, the last line
#      says FAILED and the exit code is non-zero — there is no arrangement of
#      this output that lets a partial pass read as a pass.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

STEPS=(typecheck lint build)
NAMES=()
CODES=()
LOGDIR=$(mktemp -d)
trap 'rm -rf "$LOGDIR"' EXIT

for step in "${STEPS[@]}"; do
  printf '\n════════ %s ════════\n' "$step"
  npm run --silent "$step" 2>&1 | tee "$LOGDIR/$step.log"
  code=${PIPESTATUS[0]}
  NAMES+=("$step")
  CODES+=("$code")
done

printf '\n════════ test ════════\n'
npm test 2>&1 | tee "$LOGDIR/test.log"
test_code=${PIPESTATUS[0]}
NAMES+=("test")
CODES+=("$test_code")

# The counts, not just the exit code. `-1` means the line was absent entirely,
# which is itself a failure: a suite that printed no summary did not run.
counts=$(grep -E '^# (tests|pass|fail|skipped)' "$LOGDIR/test.log" | tr '\n' ' ')
fails=$(grep -E '^# fail' "$LOGDIR/test.log" | grep -oE '[0-9]+' | head -1)
skips=$(grep -E '^# skipped' "$LOGDIR/test.log" | grep -oE '[0-9]+' | head -1)
: "${fails:=-1}"
: "${skips:=-1}"

printf '\n════════════════════ GATE SUMMARY ════════════════════\n'
failed=0
for i in "${!NAMES[@]}"; do
  if [ "${CODES[$i]}" -eq 0 ]; then
    printf '  %-12s exit 0   PASS\n' "${NAMES[$i]}"
  else
    printf '  %-12s exit %-3s FAIL\n' "${NAMES[$i]}" "${CODES[$i]}"
    failed=1
  fi
done
printf '  suite counts: %s\n' "${counts:-<no summary line — the suite did not run>}"

if [ "$fails" != "0" ]; then
  printf '  ⚠ %s failing test(s)\n' "$fails"
  failed=1
fi
if [ "$skips" != "0" ]; then
  # Skips are not failures, but they are the shape of a green that proves
  # nothing — surfaced so nobody has to remember to look.
  printf '  ⚠ %s SKIPPED test(s) — a skipped suite is not a passing suite\n' "$skips"
  failed=1
fi

if [ "$failed" -eq 0 ]; then
  printf '  ── GATE GREEN ──\n'
  exit 0
fi
printf '  ── GATE FAILED — do not report this branch as green ──\n'
exit 1
