#!/usr/bin/env python3
"""decision-label-guard.py — Stop hook (work-mode-gates).

A reply's decisions section ("Decisions Needed" / 待你決定 and similar headings) may only
hold items the user must decide. Every top-level item there must carry one label:
  [outbound] [payment] [delete] [permission] [tradeoff]   or   [對外] [金流] [刪除] [權限] [取捨]
An item that fits none is something the model should just do, so the reply is blocked
until it is done or relabelled.

A tradeoff item must also name what each side gains (at least two merit words such as
pros / cons / risk / 好處 / 代價 in the item and its indented lines); one that cannot is a
recommendation the model should just carry out.

Labels and the heading can be customised in the work-mode config file
(${WORK_MODE_CONFIG:-~/.config/work-mode/config.json}: converge.decisionLabels,
converge.tradeoffLabel, converge.sectionHeading). Without one, both label sets are accepted.

Fail-open on parse problems; the second pass (stop_hook_active) always passes.
"""
import json
import os
import re
import sys

DEFAULT_LABELS = ["對外", "金流", "刪除", "權限", "取捨", "outbound", "payment", "delete", "permission", "tradeoff"]
DEFAULT_TRADEOFF = ["取捨", "tradeoff"]
HEADINGS = r"待你決定|要你決定|需要你決定|待決事項|Decisions?\s+Needed|Pending\s+Decisions?|Needs?\s+Your\s+Decision"


def load_config():
    path = os.environ.get("WORK_MODE_CONFIG") or "~/.config/work-mode/config.json"
    try:
        with open(os.path.expanduser(path), encoding="utf-8") as f:
            data = json.load(f)
        conv = data.get("converge") or {}
        return conv if isinstance(conv, dict) else {}
    except (OSError, ValueError, AttributeError):
        return {}


def _strings(v):
    return [s for s in v if isinstance(s, str) and s.strip()] if isinstance(v, list) else []


_conf = load_config()
LABELS = _strings(_conf.get("decisionLabels")) or DEFAULT_LABELS
_trade = _conf.get("tradeoffLabel")
TRADEOFFS = [_trade] if isinstance(_trade, str) and _trade.strip() else DEFAULT_TRADEOFF
_heading = _conf.get("sectionHeading")
_extra = "|" + re.escape(_heading) if isinstance(_heading, str) and _heading.strip() else ""


def _alt(words):
    return "|".join(re.escape(w) for w in words)


LABEL = re.compile(r"[\[【]\s*(" + _alt(LABELS) + r")\s*[\]】]", re.I)
TRADEOFF = re.compile(r"[\[【]\s*(" + _alt(TRADEOFFS) + r")\s*[\]】]", re.I)
# The heading must be the whole line: optional markdown (#, **), an optional count in brackets,
# then either the end of the line or a colon with an inline remainder ("**待你決定**：沒有").
# "## Decisions needed for the architecture" is an ordinary heading, not this section.
_TAIL = r"\s*(?:\*\*)?\s*(?:[（(][^()（）\n]{0,40}[)）])?\s*(?:\*\*)?\s*(?:[：:].*)?$"
HEADING = re.compile(r"^\s*(#+\s*|\*\*)?\s*(" + HEADINGS + _extra + r")" + _TAIL, re.I)
# Chinese headings come in too many word orders to list (要你決定的兩件事, 需要你決定 3 件事,
# 要你決定的有三件). A short heading line counts when it holds a decide phrase and every other
# character is filler (的, 有, a count, 件/項/事...), so 「待你決定的背景」 stays an ordinary heading.
_ZH_DECIDE = re.compile(r"(?:需要|要|請|待|由)?\s*(?:你|您)\s*(?:來)?\s*(?:做)?\s*決定|待決(?:事項)?")
_ZH_FILLER = set("的有共還這些以下下列如需要請事項件個點條處地方問題情目一二兩三四五六七八九十0123456789 \t")
_ZH_COUNT = re.compile(r"[\d一二兩三四五六七八九十]+\s*[件項個點條]")
_ZH_LINE = re.compile(
    r"^\s*(?:#+\s*|\*\*)?\s*(?P<core>[^：:*（(\n]{1,24}?)\s*(?:\*\*)?\s*"
    r"(?:[（(][^()（）\n]{0,40}[)）])?\s*(?:\*\*)?\s*(?:[：:].*)?$")


def is_heading(line: str) -> bool:
    if HEADING.match(line):
        return True
    m = _ZH_LINE.match(line)
    if not m:
        return False
    core = m.group("core")
    d = _ZH_DECIDE.search(core)
    if not d:
        return False
    rest = core[:d.start()] + core[d.end():]
    if all(c in _ZH_FILLER for c in rest):
        return True
    # with a count ("待你決定的 2 條教訓") a short noun may follow it
    c = _ZH_COUNT.search(rest)
    return bool(c) and all(ch in _ZH_FILLER for ch in rest[:c.end()]) and len(rest[c.end():].strip()) <= 6


ITEM = re.compile(r"^(\d+[.)、]|[-*])\s+\S")
NONE = re.compile(r"^(沒有|無|none)\b|沒有要你決定|沒有待決|no\s+pending\s+decisions?|nothing\s+pending|^nothing\b", re.I)
# A list item whose WHOLE statement says nothing is pending ("- No work is pending.", "- 沒有", "- 無").
# "- 無法判斷，請你決定是否付款" starts with 無 but is a real item, so the match is anchored at the end.
EMPTY_ITEM = re.compile(
    r"^(?:\d+[.)、]|[-*])\s+(?:"
    r"(?:(?:除了這項|除此之外|其他|另外)[，,]?\s*)?(?:目前|暫時|這輪|本輪)?(?:沒有|無)(?:任何|其他|別的|新的)?"
    r"(?:要你(?:決定|裁決)|需要你?(?:決定|裁決)|待決|待你決定|還沒收|未完成)?(?:的)?(?:事情|事項|事|項目)?了?"
    r"|其他沒有了|none|nothing(?:\s+(?:else\s+)?(?:pending|open|to\s+decide))?|n/a"
    r"|no\b[^.,;:\n]{0,40}\b(?:pending|open|needed|to\s+decide)"
    # the empty statement must be the whole first clause; a closing suggestion may follow
    r")\s*(?:[。.！!，,](?:\s.*|[^\s].*)?)?\s*$",
    re.I,
)
# "待你決定：1 件。" / "Decisions needed: 2" — a count only; the items are the list below.
COUNT_ONLY = re.compile(r"^[\d一二兩三四五六七八九十]+\s*(?:[件項個點條]|items?)?\s*(?:事|事項)?\s*[。.]?\s*(?:[（(][^()（）]*[)）])?\s*[。.]?$", re.I)
BREAK = re.compile(r"^\s*(#+\s|\*\*[^*]+\*\*\s*$)")
MERIT = re.compile(
    r"好處|優點|優勢|代價|缺點|風險|好在|勝在|省下|省去|換來|但會|不過會|只是會|但要|不過要|卻會|少了|失去"
    r"|\b(pros?|cons?|benefits?|upsides?|downsides?|gains?|costs?|risks?|advantages?|disadvantages?|drawbacks?)\b",
    re.I,
)
ENGLISH_HEADING = re.compile(r"^\s*(#+\s*|\*\*)?\s*(Decisions?\s+Needed|Pending\s+Decisions?|Needs?\s+Your\s+Decision)" + _TAIL, re.I)


def unlabeled(msg: str) -> list:
    return [b[0].strip()[:60] for b in _items(msg) if not LABEL.search(b[0])]


def one_sided(msg: str) -> list:
    """Tradeoff items that never say what either option gains."""
    return [b[0].strip()[:60] for b in _items(msg)
            if TRADEOFF.search(b[0]) and len(MERIT.findall("\n".join(b))) < 2]


def _items(msg: str) -> list:
    text = re.sub(r"```.*?```", " ", msg, flags=re.S)
    lines = text.splitlines()
    out = []
    i = 0
    while i < len(lines):
        if not is_heading(lines[i]):
            i += 1
            continue
        head = lines[i]
        rest = re.sub(r"^[^：:]*[：:]", "", head, count=1) if re.search(r"[：:]", head) else ""
        if NONE.search(rest.strip(" *")) or EMPTY_ITEM.match("- " + rest.strip(" *")):
            i += 1
            continue
        i += 1
        if rest.strip(" *") and not COUNT_ONLY.match(rest.strip(" *")):
            # "**有一件事要你決定：<the decision>**": the heading line is the item and the
            # list under it explains that one decision
            item = [rest.strip(" *")]
            while i < len(lines) and not BREAK.match(lines[i]) and (
                    not lines[i].strip() or lines[i][0].isspace() or ITEM.match(lines[i])):
                if lines[i].strip():
                    item.append(lines[i])
                i += 1
            out.append(item)
            continue
        while i < len(lines):
            ln = lines[i]
            # any unindented non-item text (e.g. a "Sources:" line) closes the section
            if not ITEM.match(ln) and (BREAK.match(ln) or (ln.strip() and not ln[0].isspace())):
                break
            if ITEM.match(ln) and EMPTY_ITEM.match(ln):
                pass
            elif ITEM.match(ln):
                out.append([ln])
            elif out and ln.strip():
                out[-1].append(ln)
            i += 1
    return out


def is_english(msg: str) -> bool:
    return any(ENGLISH_HEADING.match(ln) for ln in msg.splitlines())


def reason(msg: str, bad: list, weak: list) -> str:
    labels = " ".join("[%s]" % l for l in LABELS)
    trade = "[%s]" % TRADEOFFS[0]
    parts = []
    if is_english(msg):
        if bad:
            parts.append("Items in the decisions section have no label:\n  " + "\n  ".join(bad) +
                         "\nStart each item with one of " + labels + ". An item that fits none is a local, "
                         "reversible step: do it now and list it as done instead of asking the user.")
        if weak:
            parts.append(trade + " items do not say what each side gains:\n  " + "\n  ".join(weak) +
                         "\n" + trade + " is only for two reasonable paths where the choice turns on the user's "
                         "preference; state what each option gains (e.g. \"Option A pros: ...; Option B pros: ...\"). "
                         "If you cannot, only one path is reasonable: follow your recommendation and list it as done.")
        return "DECISION-LABEL GUARD: " + "\n".join(parts)
    if bad:
        parts.append("「待你決定」裡有項目沒標類別：\n  " + "\n  ".join(bad) +
                     "\n每項開頭標 " + labels + " 其一。套不進任何一類的是本機可回復的事，"
                     "直接做掉並移到已照辦，不要停下來問使用者。")
    if weak:
        parts.append(trade + " 項目沒把兩邊各自的得失講清楚：\n  " + "\n  ".join(weak) +
                     "\n" + trade + " 只給「兩條路都合理、看使用者偏好」的事，請用自然連貫的句子講明兩邊各自的得失"
                     "（例如「選 A 好在…但會…；選 B 則能…」）。"
                     "如果講不出兩邊各自的得失，代表這件事只有一條路合理，你該直接照建議做掉並移到已照辦。")
    return "DECISION-LABEL GUARD：" + "\n".join(parts)


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return
    if not isinstance(data, dict) or data.get("stop_hook_active"):
        return
    msg = data.get("last_assistant_message") or ""
    if not isinstance(msg, str) or not msg:
        return
    bad = unlabeled(msg)
    weak = one_sided(msg)
    if not bad and not weak:
        return
    print(json.dumps({"decision": "block", "reason": reason(msg, bad, weak)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
