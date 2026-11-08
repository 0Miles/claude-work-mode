#!/bin/bash
# check.sh — type-check, validate and test both plugins; non-zero on any failure.
# The engine writes its API types to a temp folder when the plugin-authoring skill loads
# (or into a loaded plugin's .claude-plugin/types/). The newest copy is laid into
# plugins/work-mode/.claude-plugin/types (gitignored). CLAUDE_CODE_TYPES=<file> overrides.
set -u
cd "$(dirname "$0")" || exit 1
DST=plugins/work-mode/.claude-plugin/types/claude-code/index.d.ts
SRC=${CLAUDE_CODE_TYPES:-$(ls -t /private/tmp/claude-*/bundled-skills/*/*/plugin-authoring/types/claude-code.d.ts /tmp/claude-*/bundled-skills/*/*/plugin-authoring/types/claude-code.d.ts 2>/dev/null | head -1)}
if [ -n "$SRC" ] && [ -f "$SRC" ]; then
  mkdir -p "$(dirname "$DST")" && cp "$SRC" "$DST"
elif [ ! -f "$DST" ]; then
  echo "check: no claude-code types found; load the plugin-authoring skill once in Claude Code, or set CLAUDE_CODE_TYPES" >&2; exit 2
fi
TSC=$(command -v tsc || ls -d "$HOME"/.nvm/versions/node/*/bin/tsc 2>/dev/null | tail -1)
[ -n "$TSC" ] || { echo "check: tsc not found (npm i -g typescript)" >&2; exit 2; }
PY=$(command -v python3) || { echo "check: python3 not found" >&2; exit 2; }
fail=0
echo "== tsc"; "$TSC" -p plugins/work-mode || fail=1
echo "== validate marketplace"; claude plugin validate . || fail=1
echo "== validate work-mode"; claude plugin validate plugins/work-mode || fail=1
echo "== validate work-mode-gates"; claude plugin validate plugins/work-mode-gates || fail=1
echo "== test work-mode"; claude plugin test plugins/work-mode || fail=1
echo "== test decision-label-guard"; "$PY" plugins/work-mode-gates/hooks/decision-label-guard.selftest.py || fail=1
echo "== test gates"; bash plugins/work-mode-gates/test-gates.sh || fail=1
[ "$fail" -eq 0 ] && echo "check: all green" || echo "check: FAILED" >&2
exit "$fail"
