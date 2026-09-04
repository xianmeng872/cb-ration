#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
数据健康哨兵 —— 在 CI 抓完数据后跑，检测两类异常，异常则通过 pushplus 推微信。

检测项：
  ① 公告漏播：PROGRESS_CHANGED 登记了变化，但页面渲染逻辑（recentProgressChanges 的
     早退规则）判定不会播 → 用户看到"进度变了却没公告"。本次 2026-09-04 的「同意注册
     被吞」就是这一类。
  ② 进度数据落后：集思录接口最新进度日期 比 仓库 progress.js 最新进度日期 落后 ≥1 天
     → 抓取管道挂了（fetch_progress.py 崩但被 continue-on-error 兜住，只停这一份）。

退出码：发现异常 → 1（供 CI 判断）；健康 → 0。
推送：仅当环境变量 PUSHPLUS_TOKEN 存在时才发微信，否则只在日志报警（不发也不报错）。

本地验证：用 verify_sentinel.py（fixture 注入，不出网、不动数据文件）。
"""
import json
import os
import re
import sys
import datetime
import urllib.request
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "..", "cb", "data")

JSL_URL = os.environ.get(
    "SENTINEL_JSL_URL",
    "https://www.jisilu.cn/webapi/cb/pre/",
)
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
REFERER = "https://www.jisilu.cn/web/data/cb/"


def load_arr(filename, var_name):
    """解析 window.X = [...]; 形式的单行数据文件，返回 list。"""
    path = os.path.join(DATA_DIR, filename)
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    s = open(path, encoding="utf-8").read()
    m = re.search(r"window\." + re.escape(var_name) + r"\s*=\s*(\[.*?\]);", s, re.S)
    if not m:
        raise ValueError("解析失败: %s / %s" % (filename, var_name))
    return json.loads(m.group(1))


def _safe_int(v, default=-1):
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return default


def will_broadcast(progress, progress_nm):
    """复刻 cb/index.html recentProgressChanges() 的两处早退。返回 True=会播。"""
    if progress and _safe_int(progress) < 50:
        return False
    if str(progress) == "90" and "申购" in (progress_nm or ""):
        return False
    return True


def jsl_fetch(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Referer": REFERER,
        "X-Requested-With": "XMLHttpRequest",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8", errors="replace"))


def send_pushplus(token, title, content):
    url = "https://www.pushplus.plus/send"
    body = json.dumps({
        "token": token,
        "title": title,
        "content": content,
        "template": "txt",
    }).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            print("📨 pushplus 响应:", r.read().decode("utf-8", "replace")[:200])
    except Exception as e:
        print("⚠️ pushplus 发送失败:", repr(e))


def main():
    problems = []
    today = datetime.date.today()

    progress = load_arr("progress.js", "SNAPSHOT_PROGRESS")
    pmap = {p.get("stockCode"): p for p in progress if p.get("stockCode")}
    try:
        changed = load_arr("progress_changed.js", "PROGRESS_CHANGED")
    except FileNotFoundError:
        changed = []

    # ---- ① 公告漏播 ----
    for c in changed:
        cd = (c.get("changeDate") or "").strip()
        try:
            d = datetime.datetime.strptime(cd, "%Y-%m-%d").date()
        except Exception:
            continue
        if (today - d).days > 14:
            continue
        p = pmap.get(c.get("stockCode"))
        if not p:
            problems.append("进度库缺失 %s %s（登记于 %s）"
                            % (c.get("stockCode"), c.get("stockName"), cd))
            continue
        if not will_broadcast(p.get("progress"), p.get("progress_nm")):
            problems.append("公告漏播 %s %s：登记于 %s，但渲染判定不播（progress=%s %s）"
                            % (c.get("stockCode"), c.get("stockName"), cd,
                               p.get("progress"), p.get("progress_nm")))

    # ---- ② 进度数据落后 ----
    try:
        jsl = jsl_fetch(JSL_URL)
        arr = (jsl.get("data") or []) if isinstance(jsl, dict) else []
        jsl_max = max((x.get("progress_dt") or "") for x in arr if x.get("progress_dt"))
        repo_max = max((p.get("progress_dt") or "") for p in progress if p.get("progress_dt"))
        if jsl_max and repo_max and jsl_max > repo_max:
            gap = (datetime.datetime.strptime(jsl_max, "%Y-%m-%d").date()
                   - datetime.datetime.strptime(repo_max, "%Y-%m-%d").date()).days
            if gap >= 1:
                problems.append("进度数据落后 %d 天：接口最新 %s / 仓库 %s"
                                % (gap, jsl_max, repo_max))
    except Exception as e:
        print("⚠️ 接口比对跳过（抓取失败，非阻塞）：", repr(e))

    token = os.environ.get("PUSHPLUS_TOKEN")

    # 自检模式（CI 临时设 PUSHPLUS_SELFTEST=1）：强制发一条，确认微信通道通。
    # 正常定时运行不设这个变量，不会每天骚扰。
    if os.environ.get("PUSHPLUS_SELFTEST") and token:
        send_pushplus(token, "cb-ration 报警通道自检",
                      "大头测试：如果你收到这条，说明微信推送已接通 ✅ "
                      "以后数据停更 / 公告漏播会自动推你。")
        print("📨 自检微信已发（PUSHPLUS_SELFTEST）")

    if problems:
        print("❌ 发现 %d 项异常：" % len(problems))
        for p in problems:
            print("  -", p)
        if token:
            send_pushplus(token, "cb-ration 数据健康警报", "\n".join(problems))
        else:
            print("⚠️ 未设置 PUSHPLUS_TOKEN，仅本地报警，不发微信")
        sys.exit(1)
    else:
        print("✅ 数据健康：无漏播、进度未落后")
        sys.exit(0)


if __name__ == "__main__":
    main()
