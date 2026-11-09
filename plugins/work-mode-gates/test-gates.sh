#!/bin/bash
# Tests for the work-mode-gates PreToolUse hooks:
#   /work-mode auto off -> ask ; on -> deny with a how-to ; unrelated calls -> no output.
# Exit 0 only when every case behaves; failing cases are listed.
set -u
H="$(cd "$(dirname "$0")" && pwd)/hooks"
T=$(mktemp -d "${TMPDIR:-/tmp}/wm-gates.XXXXXX")
trap 'rm -rf "$T"' EXIT
export TEMPO_STATE_DIR="$T/state"; mkdir -p "$TEMPO_STATE_DIR"
printf '{"modes":["autonomous"]}\n' > "$TEMPO_STATE_DIR/sid-on"
printf '{"modes":[]}\n' > "$TEMPO_STATE_DIR/sid-off"
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
mkdir -p "$R/sub"; echo a > "$R/sub/inside.txt"; git -C "$R" add sub/inside.txt; git -C "$R" commit -qm sub; echo b >> "$R/sub/inside.txt"
expect "cd sub && add modified file asks" ask "$(decision git-safe-commit-gate.sh "$(bash_in 'cd sub && git add inside.txt' sid-off)")"
expect "add from a missing pathspec file asks" ask "$(decision git-safe-commit-gate.sh "$(bash_in 'git add --pathspec-from-file=nope.txt' sid-off)")"
printf 'clean.txt\n' > "$R/list-clean"; printf 'shared.txt\n' > "$R/list-shared"
expect "add from a pathspec file of clean files passes" none "$(decision git-safe-commit-gate.sh "$(bash_in 'git add --pathspec-from-file=list-clean' sid-off)")"
expect "add from a pathspec file with a shared file asks" ask "$(decision git-safe-commit-gate.sh "$(bash_in 'git add --pathspec-from-file list-shared' sid-off)")"
expect "commit --pathspec-from-file asks" ask "$(decision git-safe-commit-gate.sh "$(bash_in 'git commit -m x --pathspec-from-file=list-clean' sid-off)")"
expect "redirection is not a path" none "$(decision git-safe-commit-gate.sh "$(bash_in 'git commit -m "ok" 2>&1 | tail -5' sid-off)")"
expect "redirect to file is not a path" none "$(decision git-safe-commit-gate.sh "$(bash_in 'git commit -m ok > /tmp/out.log' sid-off)")"
expect "newline ends the git command" none "$(decision git-safe-commit-gate.sh "$(bash_in $'git commit -m ok\necho done' sid-off)")"
expect "heredoc message body is not a path" none "$(decision git-safe-commit-gate.sh "$(bash_in $'git commit -F - <<\'EOF\'\nfeat: x\n\nbody line\nEOF' sid-off)")"
expect "add shared file asks" ask "$(decision git-safe-commit-gate.sh "$(bash_in 'git add shared.txt' sid-off)")"
expect "add shared file denies under auto" deny "$(decision git-safe-commit-gate.sh "$(bash_in 'git add shared.txt' sid-on)")"
expect "add clean file passes" none "$(decision git-safe-commit-gate.sh "$(bash_in 'git add clean.txt' sid-on)")"
expect "add -p passes" none "$(decision git-safe-commit-gate.sh "$(bash_in 'git add -p shared.txt' sid-off)")"
# Every command an auto deny tells the model to run must get past this gate; otherwise the
# model is denied again and falls back to a bulk add that sweeps in more.
for c in "printf 'y\nn\n' | git add -p -- shared.txt" "printf 'a\n' | git add -p -- shared.txt"; do
  expect "suggested route passes under auto: $c" none "$(decision git-safe-commit-gate.sh "$(bash_in "$c" sid-on)")"
done
for c in 'git add shared.txt' 'git commit -m "x" -- shared.txt'; do
  r=$(reason git-safe-commit-gate.sh "$(bash_in "$c" sid-on)")
  expect "auto deny pipes answers into git add -p ($c)" 1 "$(grep -cF '| git add -p -- <file>' <<<"$r")"
  expect "auto deny warns off bulk adds ($c)" 1 "$(grep -cF 'git commit -a' <<<"$r")"
  expect "auto deny never offers a plain git add <file> ($c)" 0 "$(grep -cF 'or git add <file> when' <<<"$r")"
done
expect "add -A passes" none "$(decision git-safe-commit-gate.sh "$(bash_in 'git add -A' sid-off)")"
expect "unrelated bash passes" none "$(decision git-safe-commit-gate.sh "$(bash_in 'ls -la' sid-on)")"

# A file this session edited from a clean start (own-edits.py) may be added whole.
export WORK_MODE_EDITS_DIR="$T/edits"
edit_in() { jq -n --arg f "$1" --arg s "$2" '{session_id:$s,tool_name:"Edit",tool_input:{file_path:$f,old_string:"a",new_string:"b"}}'; }
track() { python3 "$H/own-edits.py" "$1" <<<"$(edit_in "$2" "$3")"; }  # track <pre|post> <file> <sid>
edit_as() { track pre "$1" "$2"; echo "$3" >> "$1"; track post "$1" "$2"; }  # one Edit call as the hooks see it
echo a > "$R/own.txt"; echo a > "$R/later.txt"; git -C "$R" add own.txt later.txt; git -C "$R" commit -qm own
edit_as "$R/own.txt" sid-on b
expect "own edit from a clean start passes under auto" none "$(decision git-safe-commit-gate.sh "$(bash_in 'git add own.txt' sid-on)")"
edit_as "$R/own.txt" sid-on c
expect "a second own edit still passes" none "$(decision git-safe-commit-gate.sh "$(bash_in 'git add own.txt' sid-on)")"
expect "own file through ./ passes" none "$(decision git-safe-commit-gate.sh "$(bash_in 'git add ./own.txt' sid-on)")"
expect "another session's add of the same file still asks" ask "$(decision git-safe-commit-gate.sh "$(bash_in 'git add own.txt' sid-off)")"
expect "own file next to a shared one still denies" deny "$(decision git-safe-commit-gate.sh "$(bash_in 'git add own.txt shared.txt' sid-on)")"
edit_as "$R/shared.txt" sid-on c
expect "editing a file that was already dirty does not make it own" deny "$(decision git-safe-commit-gate.sh "$(bash_in 'git add shared.txt' sid-on)")"
edit_as "$R/later.txt" sid-on b
echo x >> "$R/later.txt"
expect "a change after the session's last edit denies" deny "$(decision git-safe-commit-gate.sh "$(bash_in 'git add later.txt' sid-on)")"
edit_as "$R/later.txt" sid-on c
expect "and the file stays mixed after the next edit" deny "$(decision git-safe-commit-gate.sh "$(bash_in 'git add later.txt' sid-on)")"
expect "tracker prints nothing" "" "$(track pre "$R/own.txt" sid-on)"
expect "tracker ignores a path-like session id" 0 "$(track pre "$R/own.txt" '../x'; ls "$T" | grep -c '^x$')"

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
