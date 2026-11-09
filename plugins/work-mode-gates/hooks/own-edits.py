#!/usr/bin/env python3
"""own-edits.py — PreToolUse / PostToolUse [Edit|Write|MultiEdit|NotebookEdit] (work-mode-gates).

Remembers which tracked files hold only this session's edits, so git-safe-commit-gate can let a
plain `git add <file>` through for them instead of asking whose hunks are whose.

A file is owned when it was tracked and clean (nothing staged, nothing unstaged) the first time
this session edited it, and before each later edit it still holds exactly what the session's
previous edit left. Anything else (a dirty start, a parallel session or the user touching it, a
change made through Bash) marks it mixed for the rest of the session, and the gate keeps asking.
The gate also compares the file with the last recorded content, so a change made after the
session's last edit is caught too.

Usage: own-edits.py pre|post, with the hook JSON on stdin. It never blocks and prints nothing;
any problem leaves the file unrecorded or mixed, which is the gate's safe side.

State: ${WORK_MODE_EDITS_DIR:-~/.claude/state/work-mode-gates/edits}/<session_id>/<sha1 of real path>,
holding "own <blob id>" or "mixed". Session folders left untouched for a week are pruned.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

KEEP_DAYS = 7


def base_dir():
    return os.environ.get("WORK_MODE_EDITS_DIR") or os.path.expanduser("~/.claude/state/work-mode-gates/edits")


def record_path(sid, path):
    """The state file for one session and one file; None when the session id is unusable."""
    if not isinstance(sid, str) or not sid or "/" in sid or ".." in sid:
        return None
    key = hashlib.sha1(os.path.realpath(path).encode("utf-8", "surrogateescape")).hexdigest()
    return os.path.join(base_dir(), sid, key)


def git(path, *args):
    d, name = os.path.split(os.path.realpath(path))
    return subprocess.run(["git", "-C", d, *args, "--", name], capture_output=True, text=True, timeout=5)


def blob(path):
    """The file's content id, without filters, so the gate computes the same one."""
    r = git(path, "hash-object", "--no-filters")
    return r.stdout.strip() if r.returncode == 0 else ""


def first_state(path):
    """'own' for a tracked file with nothing staged or unstaged, 'mixed' for a tracked file that is
    already changed, None when git does not track it (the gate never asks about those)."""
    if git(path, "ls-files", "--error-unmatch").returncode != 0:
        return None
    r = git(path, "status", "--porcelain")
    if r.returncode != 0:
        return None
    return "own" if r.stdout.strip() == "" else "mixed"


def read(rec):
    try:
        with open(rec, encoding="utf-8") as f:
            return f.read().split()
    except OSError:
        return None


def prune(base):
    cutoff = time.time() - KEEP_DAYS * 86400
    try:
        for name in os.listdir(base):
            p = os.path.join(base, name)
            if os.path.isdir(p) and not os.path.islink(p) and os.path.getmtime(p) < cutoff:
                shutil.rmtree(p, ignore_errors=True)
    except OSError:
        pass


def write(rec, text):
    d = os.path.dirname(rec)
    if not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)
        prune(os.path.dirname(d))
    tmp = "%s.%d.tmp" % (rec, os.getpid())
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text + "\n")
    os.replace(tmp, rec)


def main():
    phase = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return
    if not isinstance(data, dict):
        return
    ti = data.get("tool_input")
    ti = ti if isinstance(ti, dict) else {}
    path = ti.get("file_path") or ti.get("notebook_path")
    if not isinstance(path, str) or not os.path.isabs(path):
        return
    rec = record_path(data.get("session_id"), path)
    if rec is None:
        return
    state = read(rec)
    if phase == "pre":
        if not state:
            if not os.path.isfile(path):
                return  # a new file is untracked, and the gate never asks about untracked files
            first = first_state(path)
            if first == "own":
                write(rec, "own " + blob(path))
            elif first == "mixed":
                write(rec, "mixed")
        elif state[0] == "own" and (len(state) < 2 or blob(path) != state[1]):
            # changed since this session's last edit: someone else's work may be in it now
            write(rec, "mixed")
    elif phase == "post":
        if state and state[0] == "own":
            write(rec, "own " + blob(path))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass  # never get in the way of an edit
