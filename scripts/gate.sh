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
#   2. It reads the suite's own counts out of its summary block — tests, pass,
#      fail, cancelled, skipped, todo — not just the exit code, and treats every
#      test that did not PASS as a failure. A run that silently skipped every DB
#      test exits 0. That has happened here (`SKIP_WHEN_NO_DB` misused as
#      `{ skip: ... }` skips forever while reporting green). So does a throwing
#      `{ todo: true }` test, which node:test scores `# pass 0 / # fail 0 /
#      # todo 1` and exit 0.
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

# ── Reading the suite, not the exit code ──────────────────────────────────────
#
# Two ways this used to lie, both found by adversarial review on 2026-08-03:
#
#   a. It grepped `# fail` and `# skipped` and nothing else. node:test reports a
#      `{ todo: true }` test that THROWS as passing-with-directive:
#        `# tests 1 / # pass 0 / # fail 0 / # skipped 0 / # todo 1`, exit 0.
#      Nothing in that shape is a failure to a reader who only looks at two of
#      the counters, so a broken test marked todo was gate green. Verified
#      against real node:test v22 output, not assumed.
#   b. It took `head -1` of a grep over the WHOLE log. The summary is the LAST
#      thing the run prints; the first `^# fail` line anywhere in several
#      thousand lines of output is not necessarily part of it. Whatever the
#      backstop is for, it is not "whichever line got there first".
#
# So: parse the LAST COMPLETE summary block and decide from that alone. A block
# is `# tests N` … `# duration_ms N`, and every counter must be inside it.
# Anchoring each pattern with `$` matters too — node's TAP reporter escapes `#`
# in test output as `# \# fail 0`, which must not be mistaken for a counter.
#
# The display line below is rendered from the same parse that makes the
# decision. Printing one number and deciding on another is how you get a summary
# that disagrees with its own verdict.
read -r n_tests n_pass n_fail n_cancelled n_skipped n_todo <<EOF
$(awk '
  /^# tests [0-9]+$/      { t=$3; p=""; f=""; c=0; s=""; d=""; inblock=1; next }
  !inblock                { next }
  /^# pass [0-9]+$/       { p=$3; next }
  /^# fail [0-9]+$/       { f=$3; next }
  /^# cancelled [0-9]+$/  { c=$3; next }
  /^# skipped [0-9]+$/    { s=$3; next }
  /^# todo [0-9]+$/       { d=$3; next }
  /^# duration_ms /       {
    if (p != "" && f != "" && s != "" && d != "") {
      T=t; P=p; F=f; C=c; S=s; D=d; found=1
    }
    inblock=0; next
  }
  END { if (found) print T, P, F, C, S, D }
' "$LOGDIR/test.log")
EOF

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
if [ -z "${n_tests:-}" ]; then
  printf '  suite counts: <no node:test summary block — the suite did not run>\n'
  printf '  ⚠ no complete summary block in the test log — nothing here proves a test ran\n'
  failed=1
else
  printf '  suite counts: tests %s | pass %s | fail %s | cancelled %s | skipped %s | todo %s\n' \
    "$n_tests" "$n_pass" "$n_fail" "$n_cancelled" "$n_skipped" "$n_todo"

  if [ "$n_fail" != "0" ]; then
    printf '  ⚠ %s failing test(s)\n' "$n_fail"
    failed=1
  fi
  # Everything below is a test that did not pass while the exit code said 0.
  # Each one is a green that proves nothing, so each one is a failure here.
  if [ "$n_skipped" != "0" ]; then
    printf '  ⚠ %s SKIPPED test(s) — a skipped test is not a passing test\n' "$n_skipped"
    failed=1
  fi
  if [ "$n_todo" != "0" ]; then
    # A todo that throws is reported `not ok … # TODO` and counted here and
    # NOWHERE else — not in fail, not in pass. Unread, it is invisible.
    printf '  ⚠ %s TODO test(s) — a todo is not a passing test, and a todo that throws is counted here and nowhere else\n' "$n_todo"
    failed=1
  fi
  if [ "$n_cancelled" != "0" ]; then
    printf '  ⚠ %s CANCELLED test(s) — a cancelled test is not a passing test\n' "$n_cancelled"
    failed=1
  fi
  if [ "$n_tests" -eq 0 ]; then
    printf '  ⚠ the suite reported 0 tests — a suite that ran nothing cannot be green\n'
    failed=1
  elif [ "$n_pass" -eq 0 ]; then
    printf '  ⚠ 0 of %s test(s) passed — an all-zero pass count is not a green suite\n' "$n_tests"
    failed=1
  fi
fi

if [ "$failed" -eq 0 ]; then
  printf '  ── GATE GREEN ──\n'
  exit 0
fi
printf '  ── GATE FAILED — do not report this branch as green ──\n'
exit 1
