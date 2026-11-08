#!/bin/bash
# PreToolUse[Bash] — two git habits that sweep up edits that are not yours:
#   git commit -- <pathspec>  commits the path's whole working-tree content, not only what is staged
#   git add <file>            on a file that already had unstaged changes stages all of them
# Either one can swallow a parallel session's (or the user's) unfinished edits.
# Normally this asks; under /work-mode auto it denies with the standard alternative
# (git add -p, then a plain git commit) so the model carries on without asking.

INPUT=$(cat)
. "$(dirname "$0")/lib/tempo-auto.sh" 2>/dev/null || tempo_auto_on() { return 1; }
command -v jq >/dev/null 2>&1 || exit 0

TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null) || exit 0
[ "$TOOL" = "Bash" ] || exit 0
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null) || exit 0
[ -z "$COMMAND" ] && exit 0
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // ""' 2>/dev/null)
[ -n "$CWD" ] && [ -d "$CWD" ] && cd "$CWD" 2>/dev/null

# Drop -m/--message values so a " -- " inside a commit message is not read as a pathspec.
SCAN=$(printf '%s\n' "$COMMAND" | sed -E "s/(-m|--message)(=|[[:space:]]+)\"[^\"]*\"//g; s/(-m|--message)(=|[[:space:]]+)'[^']*'//g")

decide() {  # decide <tag> <auto-reason> <ask-reason>
  if tempo_auto_on "$INPUT"; then tempo_deny "[$1][tempo:autonomous] $2"; exit 0; fi
  jq -n --arg r "[$1] $3" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:$r}}'
  exit 0
}

if printf '%s\n' "$SCAN" | grep -qE '(^|[;&|[:space:]])git[[:space:]]+(-C[[:space:]]+[^[:space:]]+[[:space:]]+)?commit\b.*[[:space:]]--[[:space:]]+[^[:space:]]'; then
  decide git-commit-pathspec \
    "git commit -- <pathspec> commits the whole working-tree content of that path and can sweep in edits that are not yours. Do not stop to ask: stage only your own hunks with git add -p <file> (or git add <file> when every change in it is yours), check git diff --cached, then commit with a plain git commit -m ... and no pathspec." \
    "git commit -- <pathspec> commits the WORKING-TREE content of that path (like git add + commit), not only what is staged, so it can sweep in a parallel session's or the user's unstaged edits. To commit what is staged, drop the pathspec; to pick your own changes, use git add -p first."
fi

if printf '%s\n' "$COMMAND" | grep -qE '(^|[;&|[:space:]])git[[:space:]]+add[[:space:]]+(-[A-Za-z]+[[:space:]]+)*[^-[:space:]][^[:space:]]*[[:space:]]*$' \
   && ! printf '%s\n' "$COMMAND" | grep -qE 'git[[:space:]]+add[[:space:]]+(-p|--patch|-A|--all|\.)([[:space:]]|$)'; then
  TARGET=$(printf '%s\n' "$COMMAND" | grep -oE 'git[[:space:]]+add[[:space:]]+(-[A-Za-z]+[[:space:]]+)*[^-[:space:]][^[:space:]]*[[:space:]]*$' | awk '{print $NF}' | tr -d "\"'")
  if [ -n "$TARGET" ] && git status --porcelain -- "$TARGET" 2>/dev/null | grep -qE '^.M|^M.'; then
    decide git-add-shared-file \
      "$TARGET already had unstaged changes before this add; git add would stage all of them, including edits that may not be yours. Do not stop to ask: use git add -p $TARGET to stage only your own hunks, check git diff --cached, then commit. If you cannot tell which hunks are yours, put the file on the pending list and continue with the rest." \
      "$TARGET already shows unstaged modifications; they may belong to a parallel session or the user. git add <file> stages the ENTIRE working-tree content. Use git add -p to pick hunks, or confirm you mean to stage all of it."
  fi
fi
exit 0
