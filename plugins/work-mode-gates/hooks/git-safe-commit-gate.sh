#!/bin/bash
# PreToolUse[Bash] — two git habits that sweep up edits that are not yours:
#   git commit [--] <pathspec>  commits the paths' whole working-tree content, not only what is staged
#   git add <file>...           on a file that already had unstaged changes stages all of them
# Either one can swallow a parallel session's (or the user's) unfinished edits.
# Normally this asks; under /work-mode auto it denies with the standard alternative
# (git add -p fed its answers through a pipe, then a plain git commit) so the model
# carries on without asking.
# Bulk adds (-A, --all, -u, .) and interactive ones (-p, -i, -e) are left alone: they are explicit.
# A file whose every change came from this session's own Edit/Write calls (recorded by
# own-edits.py) may be added whole: nobody else's work can be in it.
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
# own-edits.py's records for this session (same folder layout, same id check as there)
SID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null)
case "$SID" in ""|*/*|*..*) EDITS="" ;; *) EDITS="${WORK_MODE_EDITS_DIR:-$HOME/.claude/state/work-mode-gates/edits}/$SID" ;; esac

# Prints one finding per line: "commit<TAB><path>" or "add<TAB><path>" (the path as typed).
FOUND=$(GATE_CMD="$COMMAND" GATE_CWD="$CWD" GATE_EDITS="$EDITS" python3 - <<'PY' 2>/dev/null
import hashlib, os, shlex, subprocess

cmd, cwd, edits = os.environ["GATE_CMD"], os.environ["GATE_CWD"], os.environ.get("GATE_EDITS", "")
try:
    lex = shlex.shlex(cmd, posix=True, punctuation_chars=";&|()<>\n")
    lex.whitespace = " \t\r"
    lex.whitespace_split = True
    tokens = list(lex)
except ValueError:
    raise SystemExit(0)

SEP = set(";&|()\n")
segments, cur = [], []
k = 0
while k < len(tokens):
    t = tokens[k]
    if t and any(c in "<>" for c in t) and all(c in "<>&|" for c in t):
        # a redirection: drop it, its target word, and an fd number glued before it ("2>&1")
        if cur and cur[-1].isdigit():
            cur.pop()
        k += 2
        continue
    if t and all(c in SEP for c in t):
        if cur:
            segments.append(cur)
        cur = []
    else:
        cur.append(t)
    k += 1
if cur:
    segments.append(cur)

# git global options that take a value as the next word
GLOBAL_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"}
# git commit options that take a value as the next word
COMMIT_VALUE = {"-m", "--message", "-F", "--file", "-C", "--reuse-message", "-c", "--reedit-message",
                "--author", "--date", "-t", "--template", "--cleanup", "--fixup", "--squash",
                "--trailer"}
ADD_SKIP_LONG = {"--patch", "--interactive", "--edit", "--all", "--update", "--no-ignore-removal",
                 "--dry-run"}
FROM_FILE = "--pathspec-from-file"
ADD_SKIP_SHORT = set("piAuen")


def modified(repo, path):
    try:
        out = subprocess.run(["git", "-C", repo, "status", "--porcelain", "--", path],
                             capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return False
    return any(len(l) > 1 and (l[0] == "M" or l[1] == "M") for l in out.splitlines())


def own(repo, path):
    """True when own-edits.py saw this session make every change the file holds right now."""
    if not edits:
        return False
    full = os.path.realpath(os.path.join(repo, os.path.expanduser(path)))
    if not os.path.isfile(full):
        return False
    key = hashlib.sha1(full.encode("utf-8", "surrogateescape")).hexdigest()
    try:
        with open(os.path.join(edits, key), encoding="utf-8") as fh:
            rec = fh.read().split()
    except OSError:
        return False
    if len(rec) != 2 or rec[0] != "own":
        return False
    d, name = os.path.split(full)
    try:
        now = subprocess.run(["git", "-C", d, "hash-object", "--no-filters", "--", name],
                             capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        return False
    # changed after the session's last edit: someone else may have added to it
    return now == rec[1]


def is_env(word):
    return "=" in word and not word.startswith("-") and word.split("=", 1)[0].replace("_", "a").isalnum()


base = cwd
for seg in segments:
    if seg[0] in ("cd", "pushd") and len(seg) > 1:
        base = os.path.join(base, os.path.expanduser(seg[1]))
        continue
    i = 0
    while i < len(seg) and (is_env(seg[i]) or seg[i] in ("command", "env", "sudo", "time", "nice")):
        i += 1
    if i >= len(seg) or os.path.basename(seg[i]) != "git":
        continue
    i += 1
    repo = base
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
            elif a.split("=", 1)[0] == FROM_FILE:
                # paths read from a file cannot be checked here: treat them as paths
                paths.append("(" + a + ("" if "=" in a else " " + (args[j + 1] if j + 1 < len(args) else "")) + ")")
                if "=" not in a:
                    j += 1
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
        from_file = None
        for n, a in enumerate(args):
            if after_dd or not a.startswith("-"):
                if n > 0 and args[n - 1] == FROM_FILE:
                    continue
                paths.append(a)
            elif a == "--":
                after_dd = True
            elif a.split("=", 1)[0] == FROM_FILE:
                from_file = a.split("=", 1)[1] if "=" in a else (args[n + 1] if n + 1 < len(args) else "")
            else:
                opts.append(a)
        if any(o.split("=", 1)[0] in ADD_SKIP_LONG for o in opts if o.startswith("--")):
            continue
        if any(set(o[1:]) & ADD_SKIP_SHORT for o in opts if not o.startswith("--")):
            continue
        if any(p in (".", ":/", ":") for p in paths):
            continue
        if from_file is not None:
            # the paths live in a file (or stdin): read them when possible, else treat the add as unknown
            listed = None
            try:
                if from_file not in ("", "-"):
                    with open(os.path.join(repo, os.path.expanduser(from_file)), encoding="utf-8") as fh:
                        listed = [l.strip() for l in fh if l.strip()]
            except OSError:
                listed = None
            if listed is None:
                print("add\t(paths from " + (from_file or "stdin") + ")")
                continue
            paths.extend(listed)
        for p in paths:
            if modified(repo, p) and not own(repo, p):
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

# The how-to in an auto deny must name only commands this gate lets through, or the model is
# denied again and falls back to a bulk add. A plain `git add <file>` on a modified file is
# denied here whoever made the edits, so the only per-file route is git add -p, and the
# model's shell has no terminal: answers are piped, one line per hunk.
HOW_TO="Review the changes with git diff -- <file>, then stage only your own hunks. git add -p has no terminal here, so pipe one answer per hunk in order (y stages, n skips), e.g. printf 'y\nn\n' | git add -p -- <file>; when every hunk is yours, printf 'a\n' | git add -p -- <file> stages them all. A plain git add <file> is denied again by this gate, and git add -A, git add ., git add -u or git commit -a stage the same edits and more, so do not switch to them. Check git diff --cached, then commit with a plain git commit -m ... and no paths."

if [ -n "$COMMIT_PATHS" ]; then
  decide git-commit-pathspec \
    "git commit with paths ($COMMIT_PATHS) commits their whole working-tree content and can sweep in edits that are not yours. Do not stop to ask. $HOW_TO" \
    "git commit with paths ($COMMIT_PATHS) commits the WORKING-TREE content of those paths (like git add + commit), not only what is staged, so it can sweep in a parallel session's or the user's unstaged edits. To commit what is staged, drop the paths; to pick your own changes, use git add -p first."
fi
if [ -n "$ADD_PATHS" ]; then
  decide git-add-shared-file \
    "$ADD_PATHS has unstaged changes that this session's own edits do not fully account for, and git add <file> would stage all of them. Do not stop to ask. $HOW_TO If you cannot tell which hunks are yours, put the file on the pending list and continue with the rest." \
    "$ADD_PATHS already shows unstaged modifications; they may belong to a parallel session or the user. git add <file> stages the ENTIRE working-tree content. Use git add -p to pick hunks, or confirm you mean to stage all of it."
fi
exit 0
