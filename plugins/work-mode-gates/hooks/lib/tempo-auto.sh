#!/bin/bash
# Shared by the PreToolUse gates. `/work-mode auto` (work-mode plugin) writes
# ~/.claude/state/tempo/<session_id> = {"modes":[...]}. While "autonomous" is in the
# list, a gate that would "ask" denies instead, with a reason telling Claude how to
# proceed on its own. Hard-stop gates (outgoing messages, secrets, installs, credentials,
# destructive git, payments, production) should never use this file's decision.
#   tempo_mode_on "$INPUT" <mode> -> exit 0 only when the hook's session has <mode> on
#   tempo_auto_on "$INPUT"        -> same, for "autonomous"
#   tempo_deny "<reason>"         -> prints a PreToolUse deny JSON
# Missing, unreadable or malformed state counts as off: the gate keeps asking.
# TEMPO_STATE_DIR overrides the state folder (tests).
tempo_mode_on() {
  local sid f
  sid=$(printf '%s' "$1" | jq -r '.session_id // ""' 2>/dev/null) || return 1
  case "$sid" in ""|*/*|*..*) return 1;; esac
  f="${TEMPO_STATE_DIR:-$HOME/.claude/state/tempo}/$sid"
  [ -f "$f" ] || return 1
  jq -e --arg m "$2" '((.modes // []) | index($m)) != null' "$f" >/dev/null 2>&1
}

tempo_auto_on() { tempo_mode_on "$1" autonomous; }

tempo_deny() {
  jq -n --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
}
