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
import re
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta

JSL_URL = "https://www.jisilu.cn/data/cbnew/pre_list/?___jsl=LST___"
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_PATH = os.path.normpath(os.path.join(BASE_DIR, "..", "cb", "data", "pending.json"))
# 与 fetch_progress.py 共享同一份「流通盘缓存」，避免重复请求 emweb 且保证锁定比例口径一致
CACHE = os.path.normpath(os.path.join(BASE_DIR, "..", "cb", "流通盘缓存.json"))
JSON_OUT = os.path.normpath(os.path.join(BASE_DIR, "..", "cb", "待发债快照.json"))

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

EM_HOLDER = "https://emweb.securities.eastmoney.com/PC_HSF10/ShareholderResearch/PageAjax?code=CODE"

# 页面需要的字段（其余丢弃以控制体积，避免仓库无意义膨胀）
KEEP = [
    "bond_id", "bond_nm", "stock_id", "stock_nm",
    "apply_date", "record_dt", "list_date",
    "ration", "apply10", "convert_price", "amount",
    "rating_cd", "apply_cd", "ration_cd", "price",
    "progress_nm", "cb_type",
]


def em_code(sc):
    if not sc:
        return ""
    if sc[0] in "69":
        return "SH" + sc
    if sc[0] in "84":
        return "BJ" + sc
    return "SZ" + sc


def _ts(s):
    try:
        return datetime.strptime(str(s).strip()[:19], "%Y-%m-%d %H:%M:%S").timestamp()
    except Exception:
        try:
            return datetime.strptime(str(s).strip()[:10], "%Y-%m-%d").timestamp()
        except Exception:
            return 0


def get_lock_ratio(stock_code, cache):
    """emweb 十大股东锁定比例 = 持股≥5% 的股东合计（与 fetch_progress.py 算法一致）。失败返回 None。"""
    if not stock_code:
        return None
    if stock_code in cache and cache[stock_code] is not None:
        return cache[stock_code]
    url = EM_HOLDER.replace("CODE", em_code(stock_code))
    for attempt in range(2):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Accept": "application/json, text/javascript, */*; q=0.01",
                "Accept-Language": "zh-CN,zh;q=0.9",
                "Referer": "https://emweb.securities.eastmoney.com/",
            })
            with urllib.request.urlopen(req, timeout=15) as r:
                d = json.loads(r.read().decode("utf-8", errors="replace"))
            sdhg = d.get("sdgd") or []
            if not sdhg:
                continue
            times = [t for x in sdhg if (t := _ts(x.get("END_DATE"))) > 0]
            if not times:
                continue
            max_t = max(times)
            latest = [x for x in sdhg if _ts(x.get("END_DATE")) == max_t]
            seen, uniq = set(), []
            for x in latest:
                k = x.get("HOLDER_NAME")
                if k and k not in seen:
                    seen.add(k)
                    uniq.append(x)
            lock = sum(float(x.get("HOLD_NUM_RATIO") or 0) for x in uniq if float(x.get("HOLD_NUM_RATIO") or 0) >= 5)
            if lock <= 0:
                continue
            v = round(min(lock, 100), 2)
            cache[stock_code] = v
            return v
        except Exception as e:
            print("  [warn] %s emweb 第%d次失败: %s" % (stock_code, attempt + 1, e), file=sys.stderr)
    return None


def compute_est_float(stock_code, scale, cache, old_map):
    """预估流通盘(亿) = 规模 × (1 − 持股≥5%股东的锁定比例)。
    优先继承旧值（避免每日重复请求 emweb），否则实时拉取 emweb 计算。"""
    if not stock_code or not scale:
        return None
    if stock_code in old_map and old_map[stock_code] is not None:
        return old_map[stock_code]
    lock = get_lock_ratio(stock_code, cache)
    if lock is not None:
        return round(float(scale) * (1 - lock / 100), 2)
    return None


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

    # 读取旧 pending.json，按 stock_id 建立 estFloat 继承表（避免每日重复请求 emweb）
    old_est = {}
    if os.path.exists(OUT_PATH):
        try:
            old_j = json.load(open(OUT_PATH, encoding="utf-8"))
            for r in (old_j.get("rows") or []):
                c = r.get("cell") or {}
                sc = c.get("stock_id")
                ef = c.get("estFloat")
                if sc and ef is not None:
                    old_est[sc] = ef
        except Exception:
            old_est = {}

    # emweb 锁定比例缓存（与 fetch_progress.py 共享同一份文件，保证口径一致且减少重复请求）
    cache = {}
    if os.path.exists(CACHE):
        try:
            cache = json.load(open(CACHE, encoding="utf-8"))
        except Exception:
            cache = {}
    for k in [k for k, v in cache.items() if v is None]:
        del cache[k]

    est_new = 0
    # 只保留未上市的债（list_date 为空）——这些才是「待发/待申购」，已上市的页面不需要
    out = []
    for r in rows:
        c = r.get("cell") or {}
        if c.get("list_date"):
            continue
        cell = {k: c.get(k) for k in KEEP}
        # 预估流通盘：规模 × (1 − 锁定比例)，继承旧值或实时从 emweb 计算
        ef = compute_est_float(
            cell.get("stock_id"), cell.get("amount"), cache, old_est)
        if ef is not None:
            cell["estFloat"] = ef
            est_new += 1
        out.append({"cell": cell})

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
    print("已写入:", os.path.normpath(OUT_PATH), "（估算流通盘 %d 只）" % est_new)
    # 存档（供人工核对，不参与提交）
    try:
        json.dump(out, open(JSON_OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    except Exception as e:
        print("[warn] 写待发债快照json失败:", e, file=sys.stderr)
    # 回写 emweb 锁定比例缓存（与 fetch_progress.py 共享）
    try:
        json.dump(cache, open(CACHE, "w", encoding="utf-8"), ensure_ascii=False)
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
