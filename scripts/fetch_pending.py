# -*- coding: utf-8 -*-
"""
抓取「待发新债」数据，产出同源 JSON 供页面直接读取（绕开集思录 CORS 限制）。

背景 / 为什么需要这个脚本：
  - 集思录 pre_list 是唯一同时含「申购日 + 股权登记日 + 每股配售」的权威源，但无 CORS 头，浏览器无法直连。
  - 公开 CORS 代理（allorigins / corsproxy / codetabs / cors.lol 等）实测长期不稳（408/403/429/522）。
  - 东财 RPT_BOND_CB_LIST 对刚发行公告的新债滞后数日（实测 8-17 仍未收录 8-17/8-18/8-19 申购的三只债），兜不住。
  => 结论：只能由服务端（GitHub Actions）定时抓取，写成同源静态 JSON，由 GitHub Pages 发布，页面同源 fetch。

输出结构刻意保持集思录原始形态 {"rows":[{"cell":{...}}]}，页面解析逻辑无需改动。
"""
import json
import os
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta

JSL_URL = "https://www.jisilu.cn/data/cbnew/pre_list/?___jsl=LST___"
OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "cb", "data", "pending.json")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

# 页面需要的字段（其余丢弃以控制体积，避免仓库无意义膨胀）
KEEP = [
    "bond_id", "bond_nm", "stock_id", "stock_nm",
    "apply_date", "record_dt", "list_date",
    "ration", "apply10", "convert_price", "amount",
    "rating_cd", "apply_cd", "ration_cd", "price",
    "progress_nm", "cb_type",
]


def fetch(url, timeout=30):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Referer": "https://www.jisilu.cn/data/cbnew/",
        "X-Requested-With": "XMLHttpRequest",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="replace")


def main():
    try:
        raw = fetch(JSL_URL)
        data = json.loads(raw)
    except Exception as e:
        print("[ERROR] 抓取集思录失败:", repr(e), file=sys.stderr)
        return 1

    rows = data.get("rows") or []
    if not rows:
        print("[ERROR] 集思录返回 rows 为空，判定为异常，不覆盖旧数据", file=sys.stderr)
        return 1

    # 只保留未上市的债（list_date 为空）——这些才是「待发/待申购」，已上市的页面不需要
    out = []
    for r in rows:
        c = r.get("cell") or {}
        if c.get("list_date"):
            continue
        out.append({"cell": {k: c.get(k) for k in KEEP}})

    applied = [c["cell"] for c in out if c["cell"].get("apply_date")]
    applied.sort(key=lambda x: str(x.get("apply_date") or ""))
    print("未上市债 %d 只，其中已定申购日 %d 只：" % (len(out), len(applied)))
    for c in applied:
        print("   %s %s (%s) 申购日=%s 登记日=%s 每股配=%s" % (
            c.get("bond_id"), c.get("bond_nm"), c.get("stock_nm"),
            c.get("apply_date"), c.get("record_dt"), c.get("ration")))

    # 名单内容没变就保持旧文件原样（含旧 updated），使 git diff 为空 → 不产生无意义提交与重复部署。
    # 因此 updated 的语义是「名单最后一次发生变化的时间」，不是「最后一次检查时间」。
    #
    # 【坑】比对必须排除盘中浮动字段，否则名单永远"不一致"，会每天刷出一堆垃圾提交：
    #   - price：集思录带的正股价，盘中每分钟都在变（页面真正用的是腾讯实时价，这里只是兜底）。
    #   - apply10：对「申购日未定」的债是按当前正股价反推的估算值，跟着 price 一起漂；
    #              对已定申购日的债才是发行公告里的固定值，需要参与比对。
    old_rows = None
    if os.path.exists(OUT_PATH):
        try:
            with open(OUT_PATH, "r", encoding="utf-8") as f:
                old_rows = (json.load(f) or {}).get("rows")
        except Exception:
            old_rows = None

    def norm(rs):
        """归一化用于比对：剔除实时浮动字段，只留真正定义名单与配售条件的内容。"""
        res = []
        for x in (rs or []):
            c = dict((x.get("cell") or {}))
            c.pop("price", None)
            if not c.get("apply_date"):
                c.pop("apply10", None)
            res.append(c)
        return res

    if norm(old_rows) == norm(out):
        print("名单关键信息与现有数据一致（仅正股价浮动），保持文件不变，不产生提交")
        return 0

    bj = datetime.now(timezone.utc).astimezone(timezone(timedelta(hours=8)))
    payload = {
        "updated": bj.strftime("%Y-%m-%d %H:%M:%S") + " (北京时间)",
        "source": "jisilu pre_list",
        "count": len(out),
        "rows": out,
    }

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    print("已写入:", os.path.normpath(OUT_PATH))
    return 0


if __name__ == "__main__":
    sys.exit(main())
