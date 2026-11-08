#!/bin/bash
# PreToolUse[Bash] — two git habits that sweep up edits that are not yours:
#   git commit [--] <pathspec>  commits the paths' whole working-tree content, not only what is staged
#   git add <file>...           on a file that already had unstaged changes stages all of them
# Either one can swallow a parallel session's (or the user's) unfinished edits.
# Normally this asks; under /work-mode auto it denies with the standard alternative
# (git add -p, then a plain git commit) so the model carries on without asking.
# Bulk adds (-A, --all, -u, .) and interactive ones (-p, -i, -e) are left alone: they are explicit.
# The command line is parsed with python3's shlex (quotes, `git -C dir`, `&&`/`;` chains);
# without python3 the gate stays out of the way.

INPUT=$(cat)
. "$(dirname "$0")/lib/tempo-auto.sh" 2>/dev/null || tempo_auto_on() { return 1; }
command -v jq >/dev/null 2>&1 || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null) || exit 0
[ "$TOOL" = "Bash" ] || exit 0
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null) || exit 0
[ -z "$COMMAND" ] && exit 0
case "$COMMAND" in *git*) ;; *) exit 0 ;; esac
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // ""' 2>/dev/null)
[ -n "$CWD" ] && [ -d "$CWD" ] || CWD=$PWD

# Prints one finding per line: "commit<TAB><path>" or "add<TAB><path>" (the path as typed).
FOUND=$(GATE_CMD="$COMMAND" GATE_CWD="$CWD" python3 - <<'PY' 2>/dev/null
import os, shlex, subprocess

cmd, cwd = os.environ["GATE_CMD"], os.environ["GATE_CWD"]
try:
    lex = shlex.shlex(cmd, posix=True, punctuation_chars=";&|()")
    lex.whitespace_split = True
    tokens = list(lex)
except ValueError:
    raise SystemExit(0)

segments, cur = [], []
for t in tokens:
    if t and all(c in ";&|()" for c in t):
        if cur:
            segments.append(cur)
        cur = []
    else:
        cur.append(t)
if cur:
    segments.append(cur)

# git global options that take a value as the next word
GLOBAL_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"}
# git commit options that take a value as the next word
COMMIT_VALUE = {"-m", "--message", "-F", "--file", "-C", "--reuse-message", "-c", "--reedit-message",
                "--author", "--date", "-t", "--template", "--cleanup", "--fixup", "--squash",
                "--trailer", "--pathspec-from-file"}
ADD_SKIP_LONG = {"--patch", "--interactive", "--edit", "--all", "--update", "--no-ignore-removal",
                 "--dry-run", "--pathspec-from-file"}
ADD_SKIP_SHORT = set("piAuen")


def modified(repo, path):
    try:
        out = subprocess.run(["git", "-C", repo, "status", "--porcelain", "--", path],
                             capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return False
    return any(len(l) > 1 and (l[0] == "M" or l[1] == "M") for l in out.splitlines())


def is_env(word):
    return "=" in word and not word.startswith("-") and word.split("=", 1)[0].replace("_", "a").isalnum()


for seg in segments:
    i = 0
    while i < len(seg) and (is_env(seg[i]) or seg[i] in ("command", "env", "sudo", "time", "nice")):
        i += 1
    if i >= len(seg) or os.path.basename(seg[i]) != "git":
        continue
    i += 1
    repo = cwd
    while i < len(seg) and seg[i].startswith("-"):
        opt = seg[i]
        if opt in GLOBAL_VALUE and i + 1 < len(seg):
            if opt == "-C":
                repo = os.path.join(repo, os.path.expanduser(seg[i + 1]))
            i += 2
            continue
        i += 1
    if i >= len(seg):
        continue
    sub, args = seg[i], seg[i + 1:]
    if sub == "commit":
        paths, j, after_dd = [], 0, False
        while j < len(args):
            a = args[j]
            if after_dd:
                paths.append(a)
            elif a == "--":
                after_dd = True
            elif a in COMMIT_VALUE:
                j += 1
            elif a.startswith("-") and not a.startswith("--") and len(a) > 2:
                # a short-option cluster such as -am: a value letter last takes the next word
                for k, ch in enumerate(a[1:]):
                    if ch in "mFCct":
                        if k == len(a) - 2:
                            j += 1
                        break
            elif not a.startswith("-"):
                paths.append(a)
            j += 1
        for p in paths:
            print("commit\t" + p)
    elif sub == "add":
        opts = []
        paths = []
        after_dd = False
        for a in args:
            if after_dd or not a.startswith("-"):
                paths.append(a)
            elif a == "--":
                after_dd = True
            else:
                opts.append(a)
        if any(o.split("=", 1)[0] in ADD_SKIP_LONG for o in opts if o.startswith("--")):
            continue
        if any(set(o[1:]) & ADD_SKIP_SHORT for o in opts if not o.startswith("--")):
            continue
        if any(p in (".", ":/", ":") for p in paths):
            continue
        for p in paths:
            if modified(repo, p):
                print("add\t" + p)
PY
)
[ -z "$FOUND" ] && exit 0

decide() {  # decide <tag> <auto-reason> <ask-reason>
  if tempo_auto_on "$INPUT"; then tempo_deny "[$1][tempo:autonomous] $2"; exit 0; fi
  jq -n --arg r "[$1] $3" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:$r}}'
  exit 0
}

COMMIT_PATHS=$(printf '%s\n' "$FOUND" | awk -F'\t' '$1=="commit"{print $2}' | paste -sd' ' -)
ADD_PATHS=$(printf '%s\n' "$FOUND" | awk -F'\t' '$1=="add"{print $2}' | paste -sd' ' -)

if [ -n "$COMMIT_PATHS" ]; then
  decide git-commit-pathspec \
    "git commit with paths ($COMMIT_PATHS) commits their whole working-tree content and can sweep in edits that are not yours. Do not stop to ask: stage only your own hunks with git add -p <file> (or git add <file> when every change in it is yours), check git diff --cached, then commit with a plain git commit -m ... and no paths." \
    "git commit with paths ($COMMIT_PATHS) commits the WORKING-TREE content of those paths (like git add + commit), not only what is staged, so it can sweep in a parallel session's or the user's unstaged edits. To commit what is staged, drop the paths; to pick your own changes, use git add -p first."
fi
if [ -n "$ADD_PATHS" ]; then
  decide git-add-shared-file \
    "$ADD_PATHS already had unstaged changes before this add; git add would stage all of them, including edits that may not be yours. Do not stop to ask: use git add -p on those files to stage only your own hunks, check git diff --cached, then commit. If you cannot tell which hunks are yours, put the file on the pending list and continue with the rest." \
    "$ADD_PATHS already shows unstaged modifications; they may belong to a parallel session or the user. git add <file> stages the ENTIRE working-tree content. Use git add -p to pick hunks, or confirm you mean to stage all of it."
fi
exit 0
