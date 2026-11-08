#!/bin/bash
# PreToolUse[Write] — ask before creating a new SUMMARY/REPORT/NOTES/FINDINGS/ANALYSIS*.md.
#
# These files get written as a reflex at the end of a task, then never read again, while
# the real document beside them goes stale. Only NEW files are questioned (rewriting an
# existing one is an update). Temp folders and a session scratchpad are exempt.
# Under /work-mode auto the ask becomes a deny that says what to do instead.

INPUT=$(cat)
. "$(dirname "$0")/lib/tempo-auto.sh" 2>/dev/null || tempo_auto_on() { return 1; }
command -v jq >/dev/null 2>&1 || exit 0

TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null) || exit 0
[ "$TOOL" = "Write" ] || exit 0
FP=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // ""' 2>/dev/null) || exit 0
[ -z "$FP" ] && exit 0

# already exists -> an update, not a new scratch doc
[ -e "$FP" ] && exit 0

BASE=$(basename "$FP")
printf '%s' "$BASE" | grep -qiE '^(SUMMARY|REPORT|NOTES|FINDINGS|ANALYSIS)[-_A-Za-z0-9]*\.md$' || exit 0

case "$FP" in
  /private/tmp/*|/tmp/*|*/scratchpad/*) exit 0 ;;
esac

if tempo_auto_on "$INPUT"; then
  tempo_deny "[scratch-doc-guard][tempo:autonomous] About to create $FP. Prefer updating an existing document over adding a new summary or notes file. Do not stop to ask: put the content into the existing document it belongs to; if it is only an intermediate result of this task, write it to the session scratchpad or /tmp; if it is a conclusion for the user, put it in the reply."; exit 0
fi
jq -n --arg f "$FP" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:("[scratch-doc-guard] About to create " + $f + ". Prefer updating an existing document over adding a new summary or notes file. Which existing document should this go into? Intermediate results belong in the session scratchpad or /tmp; conclusions for the user belong in the reply. Allow only if a new file is really wanted.")}}'
exit 0
