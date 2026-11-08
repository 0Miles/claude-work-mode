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
HEADING = re.compile(r"^\s*(#+\s*|\*\*)?\s*(" + HEADINGS + _extra + r")", re.I)
ITEM = re.compile(r"^(\d+[.)、]|[-*])\s+\S")
NONE = re.compile(r"^(沒有|無|none)\b|沒有要你決定|沒有待決|no\s+pending\s+decisions?|nothing\s+pending|^nothing\b", re.I)
BREAK = re.compile(r"^\s*(#+\s|\*\*[^*]+\*\*\s*$)")
MERIT = re.compile(
    r"好處|優點|優勢|代價|缺點|風險|好在|勝在|省下|省去|換來|但會|不過會|只是會|但要|不過要|卻會|少了|失去"
    r"|\b(pros?|cons?|benefits?|upsides?|downsides?|gains?|costs?|risks?|advantages?|disadvantages?|drawbacks?)\b",
    re.I,
)
ENGLISH_HEADING = re.compile(r"^\s*(#+\s*|\*\*)?\s*(Decisions?\s+Needed|Pending\s+Decisions?|Needs?\s+Your\s+Decision)", re.I)


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
        if not HEADING.match(lines[i]):
            i += 1
            continue
        head = lines[i]
        rest = re.sub(r"^[^：:]*[：:]", "", head, count=1) if re.search(r"[：:]", head) else ""
        if NONE.search(rest.strip(" *")):
            i += 1
            continue
        i += 1
        while i < len(lines):
            ln = lines[i]
            # any unindented non-item text (e.g. a "Sources:" line) closes the section
            if not ITEM.match(ln) and (BREAK.match(ln) or (ln.strip() and not ln[0].isspace())):
                break
            if ITEM.match(ln):
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
