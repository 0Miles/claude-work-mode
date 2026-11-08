#!/usr/bin/env python3
"""Self-test for decision-label-guard.py; exits non-zero on any failure.
Runs without any user config (WORK_MODE_CONFIG points at a missing file), then once with a custom one."""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HOOK = Path(__file__).with_name("decision-label-guard.py")
os.environ["WORK_MODE_CONFIG"] = os.path.join(tempfile.gettempdir(), "work-mode-selftest-no-such-file.json")


def load():
    spec = importlib.util.spec_from_file_location("g", HOOK)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


g = load()

CASES = [
    ("zh labeled items pass", "完成。\n\n**待你決定**\n1. [取捨] 要不要做 A？\n   - 建議做\n2. [對外] 寄信給客戶？\n", 0),
    ("zh unlabeled item blocks", "**待你決定**\n1. 下載成績單要你點頭\n2. [金流] 退款\n", 1),
    ("zh none inline passes", "做完了。\n\n**待你決定**：沒有。\n", 0),
    ("zh heading none passes", "## 待你決定\n沒有要你決定的。\n", 0),
    ("no section passes", "全部做完。\n", 0),
    ("nested bullets ignored", "**待你決定**\n1. [權限] 分享資料夾\n   - 我的建議：做\n   - 不做的話：讀不到\n", 0),
    ("section ends at next bold heading", "**待你決定**\n1. [取捨] 選 A\n\n**已照辦**\n- 修好 lint\n", 0),
    ("code fence ignored", "```\n**待你決定**\n1. 假的\n```\n", 0),
    ("fullwidth label passes", "**待你決定**\n- 【對外】回覆客戶\n", 0),
    ("zh dash items block", "**待你決定**\n- 要不要重開 Claude Code\n", 1),
    ("plain text line ends section", "**待你決定**\n- [取捨] 刪 A？\n\n資料來源：\n- [論文](https://x)\n", 0),
    ("en labeled items pass", "Done.\n\n## Decisions Needed\n1. [outbound] Send the reply to the client?\n2. [Payment] Refund?\n", 0),
    ("en unlabeled item blocks", "**Decisions Needed**\n- Should I restart the server?\n", 1),
    ("en none inline passes", "**Decisions Needed**: none.\n", 0),
    ("en pending heading none", "## Pending Decisions\nNo pending decisions.\n", 0),
    ("en heading that is only a prefix is not the section", "## Decisions needed for the architecture\n- We chose SQLite\n- Caching stays\n", 0),
    ("zh heading with more words is not the section", "## 待你決定的背景\n- 說明一\n", 0),
    ("heading with count and colon inside bold", "**待你決定（2 項）：**\n1. 沒標籤\n", 1),
    ("bold heading with inline none inside bold", "**待你決定：沒有**\n", 0),
    ("heading with trailing colon", "Decisions Needed:\n- restart the server?\n", 1),
    ("natural zh heading 要你決定的兩件事 is checked", "**要你決定的兩件事**\n1. 重開伺服器\n2. [對外] 寄信\n", 1),
    ("natural zh heading 要你決定的 is checked", "## 要你決定的\n- 換版面\n", 1),
    ("natural zh heading 要你決定的地方 labeled passes", "**要你決定的地方**\n- [權限] 開分享\n", 0),
    ("en empty-state item passes", "## Decisions Needed\n- No work is pending.\n", 0),
    ("en none item passes", "## Decisions Needed\n- None.\n", 0),
    ("zh empty-state item passes", "**待你決定**\n- 沒有\n", 0),
    ("en item starting with No but asking blocks", "## Decisions Needed\n- Notify the client now?\n", 1),
    ("mixed: zh label under en heading passes", "**Decisions Needed**\n1. [權限] share the folder\n", 0),
]
TRADE = [
    ("zh tradeoff with both merits passes", "**待你決定**\n1. [取捨] 版面 A 或 B？A 的好處是字大；B 的好處是一頁放完\n", 0),
    ("zh tradeoff natural prose passes", "**待你決定**\n1. [取捨] 信件要不要豁免 HTML？豁免好在像真人回信，但會少了品牌框線\n", 0),
    ("zh merits on nested lines pass", "**待你決定**\n1. [取捨] 版面 A 或 B？\n   - A 的好處：字大\n   - B 的代價：要捲動\n", 0),
    ("zh one-sided tradeoff blocks", "**待你決定**\n1. [取捨] 三條要全改嗎？建議全改，理由是同一類錯\n", 1),
    ("non-tradeoff labels skip merit check", "**待你決定**\n1. [對外] 寄信給客戶？建議寄\n", 0),
    ("en tradeoff with pros and cons passes", "## Decisions Needed\n1. [tradeoff] Layout A or B? A pros: bigger text; B pros: fits one page\n", 0),
    ("en one-sided tradeoff blocks", "## Decisions Needed\n1. [tradeoff] Change all three? I recommend it.\n", 1),
    ("en word inside another word is not a merit", "## Decisions Needed\n1. [tradeoff] Reprocess the prosody files?\n", 1),
]
fail = 0


def check(name, ok, got=""):
    global fail
    print(("PASS" if ok else "FAIL"), name, got)
    fail += not ok


for name, msg, want in TRADE:
    got = len(g.one_sided(msg))
    check(name, (got > 0) == bool(want), got)
for name, msg, want in CASES:
    got = len(g.unlabeled(msg))
    check(name, (got > 0) == bool(want), got)


def run(msg, env=None, **extra):
    payload = dict(last_assistant_message=msg, **extra)
    return subprocess.run([sys.executable, str(HOOK)], input=json.dumps(payload), capture_output=True, text=True,
                          env={**os.environ, **(env or {})})


r = run(CASES[1][1])
check("e2e block", '"decision": "block"' in r.stdout)
check("e2e zh reason has no personal name", ("Dus" + "tin") not in r.stdout and "使用者" in r.stdout)
r = run(CASES[12][1])
check("e2e en reason is English", "Items in the decisions section have no label" in json.loads(r.stdout or "{}").get("reason", ""))
r = run(CASES[1][1], stop_hook_active=True)
check("e2e second pass", r.stdout.strip() == "")
r = subprocess.run([sys.executable, str(HOOK)], input="not json", capture_output=True, text=True)
check("e2e bad input fails open", r.returncode == 0 and r.stdout.strip() == "")

# custom labels and heading from a config file
with tempfile.TemporaryDirectory() as d:
    cfg = os.path.join(d, "config.json")
    with open(cfg, "w", encoding="utf-8") as f:
        json.dump({"converge": {"sectionHeading": "Open Questions", "decisionLabels": ["external", "money", "choice"],
                                "tradeoffLabel": "choice"}}, f)
    env = {"WORK_MODE_CONFIG": cfg}
    r = run("## Open Questions\n1. [money] refund?\n2. [choice] A or B? I lean A\n", env)
    out = json.loads(r.stdout or "{}").get("reason", "")
    check("custom heading recognised, one-sided custom tradeoff blocks", "[choice]" in out)
    r = run("## Open Questions\n1. [outbound] send it?\n", env)
    check("custom labels replace the defaults", '"decision": "block"' in r.stdout)
    r = run("## Open Questions\n1. [external] send it?\n", env)
    check("custom label passes", r.stdout.strip() == "")
    with open(cfg, "w", encoding="utf-8") as f:
        f.write("{ broken")
    r = run("**待你決定**\n1. [取捨] A 的好處…；B 的好處…\n", env)
    check("broken config falls back to defaults", r.stdout.strip() == "")

sys.exit(1 if fail else 0)
