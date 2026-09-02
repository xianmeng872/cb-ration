#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CI 校验闸门：检查 cb/data/*.js 五大块数据的结构完整性。

任一检查失败 -> 退出码 1 -> workflow 失败 -> 不提交 / 不部署。
目的：把"脏数据上线"挡在发布之前，彻底杜绝此前出现的
[object Object] 乱码、宽基字典被非5大宽基值污染等问题。

仅用标准库，适配 CI（setup-python，无 node）。
"""
import json
import os
import re
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.normpath(os.path.join(BASE_DIR, "..", "cb", "data"))

# 宽基字典仅允许这 5 个值（其余一律视为污染）
ALLOWED_WIDTH = {"沪深300", "上证50", "中证500", "中证1000", "中证2000"}

FILES = {
    "kline.js": "KLINE_SNAPSHOT",
    "progress.js": "SNAPSHOT_PROGRESS",
    "progress_changed.js": "PROGRESS_CHANGED",
    "pending.js": "SNAPSHOT_PEND",
    "index_map.js": "CBK_INDEX_MAP",
}

CODE_RE = re.compile(r"^\d{6}$")


def strip_js_comments(s):
    """去掉 JS 行注释 // 与块注释 /* */，但保留字符串内的内容（数据块可能含 // 注释）。"""
    out = []
    i, n = 0, len(s)
    in_str = None
    while i < n:
        c = s[i]
        if in_str:
            out.append(c)
            if c == '\\' and i + 1 < n:
                out.append(s[i + 1]); i += 2; continue
            if c == in_str:
                in_str = None
            i += 1; continue
        if c == '"' or c == "'":
            in_str = c; out.append(c); i += 1; continue
        if c == '/' and i + 1 < n and s[i + 1] == '/':
            while i < n and s[i] != '\n':
                i += 1
            continue
        if c == '/' and i + 1 < n and s[i + 1] == '*':
            i += 2
            while i < n and not (s[i] == '*' and i + 1 < n and s[i + 1] == '/'):
                i += 1
            i += 2
            continue
        out.append(c); i += 1
    return ''.join(out)


def load(name, var):
    p = os.path.join(DATA, name)
    if not os.path.exists(p):
        print("❌ 缺失数据文件: %s" % name)
        return None
    txt = open(p, encoding="utf-8").read()
    m = re.search(r"window\." + re.escape(var) + r"\s*=\s*(.*?)\s*;\s*$", txt, re.S)
    if not m:
        print("❌ %s 格式异常（未匹配 window.%s = ...）" % (name, var))
        return None
    try:
        return json.loads(strip_js_comments(m.group(1)))
    except Exception as e:
        print("❌ %s JSON 解析失败: %s" % (name, e))
        return None


def fail(msg):
    print("❌ " + msg)
    sys.exit(1)


def main():
    data = {}
    for fn, var in FILES.items():
        v = load(fn, var)
        if v is None:
            sys.exit(1)
        data[var] = v
        print("✅ %s (%s) 解析成功" % (fn, var))

    # KLINE_SNAPSHOT: {code: [{date, close}]}
    ks = data["KLINE_SNAPSHOT"]
    if not isinstance(ks, dict):
        fail("KLINE_SNAPSHOT 应为对象")
    for c, arr in ks.items():
        if not CODE_RE.match(c):
            fail("KLINE_SNAPSHOT 键 %s 非6位代码" % c)
        if not isinstance(arr, list):
            fail("KLINE_SNAPSHOT[%s] 应为数组" % c)
        for row in arr:
            if not isinstance(row, dict) or "date" not in row or "close" not in row:
                fail("KLINE_SNAPSHOT[%s] 行结构异常: %r" % (c, row))

    # SNAPSHOT_PROGRESS / SNAPSHOT_PEND / PROGRESS_CHANGED: 数组
    for var in ("SNAPSHOT_PROGRESS", "SNAPSHOT_PEND", "PROGRESS_CHANGED"):
        if not isinstance(data[var], list):
            fail("%s 应为数组" % var)

    # CBK_INDEX_MAP: {code: [宽基名...]}，值仅限 5 大宽基
    im = data["CBK_INDEX_MAP"]
    if not isinstance(im, dict):
        fail("CBK_INDEX_MAP 应为对象")
    stray = []
    for c, vals in im.items():
        if not CODE_RE.match(c):
            fail("CBK_INDEX_MAP 键 %s 非6位代码" % c)
        if not isinstance(vals, list):
            fail("CBK_INDEX_MAP[%s] 应为数组" % c)
        for v in vals:
            if not isinstance(v, str):
                fail("CBK_INDEX_MAP[%s] 含非字符串值: %r" % (c, v))
            if v not in ALLOWED_WIDTH:
                stray.append("%s=%s" % (c, v))
    if stray:
        fail("CBK_INDEX_MAP 含非5大宽基值（会污染徽章渲染）: " + ", ".join(stray[:10]))

    print("\n🎉 校验通过：5 大数据文件结构完整，宽基字典仅含 5 大宽基。")


if __name__ == "__main__":
    main()
