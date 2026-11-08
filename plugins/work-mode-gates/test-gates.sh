#!/bin/bash
# Tests for the work-mode-gates PreToolUse hooks:
#   /work-mode auto off -> ask ; on -> deny with a how-to ; unrelated calls -> no output.
# Exit 0 only when every case behaves; failing cases are listed.
set -u
H="$(cd "$(dirname "$0")" && pwd)/hooks"
T=$(mktemp -d "${TMPDIR:-/tmp}/wm-gates.XXXXXX")
trap 'rm -rf "$T"' EXIT
export TEMPO_STATE_DIR="$T/state"; mkdir -p "$TEMPO_STATE_DIR"
printf '{"modes":["autonomous","dispatch"]}\n' > "$TEMPO_STATE_DIR/sid-on"
printf '{"modes":["dispatch"]}\n' > "$TEMPO_STATE_DIR/sid-off"
printf 'not json' > "$TEMPO_STATE_DIR/sid-garbage"
FAILS=0; N=0

R="$T/repo"; mkdir -p "$R"; git -C "$R" init -q; git -C "$R" config user.email t@t; git -C "$R" config user.name t
echo a > "$R/shared.txt"; echo a > "$R/clean.txt"; git -C "$R" add .; git -C "$R" commit -qm init
echo b >> "$R/shared.txt"

bash_in()  { jq -n --arg c "$1" --arg s "$2" --arg cwd "$R" '{session_id:$s,cwd:$cwd,tool_name:"Bash",tool_input:{command:$c}}'; }
write_in() { jq -n --arg f "$1" --arg s "$2" '{session_id:$s,tool_name:"Write",tool_input:{file_path:$f,content:"x"}}'; }

decision() {  # decision <hook> <input> -> ask|deny|none
  local out
  out=$(cd "$R" && bash "$H/$1" <<<"$2" 2>/dev/null)
  [ -z "$out" ] && { echo none; return; }
  jq -r '.hookSpecificOutput.permissionDecision // "none"' <<<"$out" 2>/dev/null
}
reason() { (cd "$R" && bash "$H/$1" <<<"$2" 2>/dev/null) | jq -r '.hookSpecificOutput.permissionDecisionReason // ""'; }

expect() {  # expect <name> <want> <got>
  N=$((N+1))
  if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 (want $2, got $3)"; FAILS=$((FAILS+1)); fi
}

for sid in sid-off sid-garbage sid-missing; do
  expect "commit pathspec asks ($sid)" ask "$(decision git-safe-commit-gate.sh "$(bash_in 'git commit -m "x" -- shared.txt' $sid)")"
done
expect "commit pathspec denies under auto" deny "$(decision git-safe-commit-gate.sh "$(bash_in 'git commit -m "x" -- shared.txt' sid-on)")"
expect "auto deny says how" 1 "$(reason git-safe-commit-gate.sh "$(bash_in 'git commit -- shared.txt' sid-on)" | grep -c 'git add -p')"
expect "dash-dash inside message is not a pathspec" none "$(decision git-safe-commit-gate.sh "$(bash_in 'git commit -m "a -- b"' sid-off)")"
expect "plain commit passes" none "$(decision git-safe-commit-gate.sh "$(bash_in 'git commit -m "msg"' sid-off)")"
expect "commit with a bare path asks" ask "$(decision git-safe-commit-gate.sh "$(bash_in 'git commit -m "x" shared.txt' sid-off)")"
expect "commit -am message is not a path" none "$(decision git-safe-commit-gate.sh "$(bash_in 'git commit -am "fix: x"' sid-off)")"
expect "commit -m with spaces passes" none "$(decision git-safe-commit-gate.sh "$(bash_in "git commit -m 'feat: a b c'" sid-off)")"
expect "commit --author value is not a path" none "$(decision git-safe-commit-gate.sh "$(bash_in 'git commit --author "A <a@b>" -m x' sid-off)")"
expect "git -C dir commit with path asks" ask "$(decision git-safe-commit-gate.sh "$(bash_in "git -C $R commit -m x shared.txt" sid-off)")"
expect "chained add then commit path asks" ask "$(decision git-safe-commit-gate.sh "$(bash_in 'git add clean.txt && git commit -m x -- clean.txt' sid-off)")"
expect "add several files, one shared, asks" ask "$(decision git-safe-commit-gate.sh "$(bash_in 'git add shared.txt clean.txt' sid-off)")"
expect "add quoted shared file asks" ask "$(decision git-safe-commit-gate.sh "$(bash_in "git add 'shared.txt'" sid-off)")"
expect "git -C add shared file asks" ask "$(decision git-safe-commit-gate.sh "$(jq -n --arg c "git -C $R add shared.txt" '{session_id:"sid-off",cwd:"/",tool_name:"Bash",tool_input:{command:$c}}')")"
expect "add -u passes" none "$(decision git-safe-commit-gate.sh "$(bash_in 'git add -u' sid-off)")"
expect "add . passes" none "$(decision git-safe-commit-gate.sh "$(bash_in 'git add .' sid-off)")"
expect "echo mentioning git add passes" none "$(decision git-safe-commit-gate.sh "$(bash_in 'echo "git add shared.txt"' sid-off)")"
expect "unbalanced quote fails open" none "$(decision git-safe-commit-gate.sh "$(bash_in 'git add "shared.txt' sid-off)")"
expect "add shared file asks" ask "$(decision git-safe-commit-gate.sh "$(bash_in 'git add shared.txt' sid-off)")"
expect "add shared file denies under auto" deny "$(decision git-safe-commit-gate.sh "$(bash_in 'git add shared.txt' sid-on)")"
expect "add clean file passes" none "$(decision git-safe-commit-gate.sh "$(bash_in 'git add clean.txt' sid-on)")"
expect "add -p passes" none "$(decision git-safe-commit-gate.sh "$(bash_in 'git add -p shared.txt' sid-off)")"
expect "add -A passes" none "$(decision git-safe-commit-gate.sh "$(bash_in 'git add -A' sid-off)")"
expect "unrelated bash passes" none "$(decision git-safe-commit-gate.sh "$(bash_in 'ls -la' sid-on)")"

expect "new SUMMARY.md asks" ask "$(decision scratch-doc-guard.sh "$(write_in "$R/SUMMARY.md" sid-off)")"
expect "new REPORT-x.md denies under auto" deny "$(decision scratch-doc-guard.sh "$(write_in "$R/REPORT-x.md" sid-on)")"
touch "$R/NOTES.md"
expect "existing NOTES.md passes" none "$(decision scratch-doc-guard.sh "$(write_in "$R/NOTES.md" sid-off)")"
expect "scratchpad passes" none "$(decision scratch-doc-guard.sh "$(write_in "/x/scratchpad/SUMMARY.md" sid-off)")"
expect "/tmp passes" none "$(decision scratch-doc-guard.sh "$(write_in "/tmp/SUMMARY.md" sid-off)")"
expect "ordinary file passes" none "$(decision scratch-doc-guard.sh "$(write_in "$R/readme-notes.txt" sid-off)")"
expect "pdf is not this plugin's business" none "$(decision scratch-doc-guard.sh "$(write_in "$R/out.pdf" sid-on)")"

expect "path traversal sid counts as off" ask "$(decision scratch-doc-guard.sh "$(write_in "$R/SUMMARY2.md" '../state/sid-on')")"

echo "$((N-FAILS))/$N passed"
[ "$FAILS" -eq 0 ]
