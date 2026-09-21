# -*- coding: utf-8 -*-
"""
抓取「审核进度」数据，重建 cb/index.html 内嵌的 SNAPSHOT_PROGRESS 快照。

背景：
  - 审核进度 Tab 读的是 cb/index.html 内嵌的 const SNAPSHOT_PROGRESS=[...] 静态数组，
    前端不会单独抓取。2026-08-11 门户重构时原 update.yml/update.mjs 被删，
    此后审核进度再无自动更新（数据冻结在 08-11），而"待发债"Tab 走 fetch_pending.py
    每天 4 次照常更新 —— 这就是"待发债是新的、审核进度是旧的"的原因。
  - 本脚本从集思录 webapi/cb/pre/ 抓全量审核进度（含 progress/progress_full 时间线），
    重建 SNAPSHOT_PROGRESS 回写 HTML，并遵循"有实质变化才写"原则，
    避免正股价浮动造成每日垃圾提交（与 fetch_pending.py 同约定）。

数据源：
  - 审核进度：https://www.jisilu.cn/webapi/cb/pre/   （含 progress_full 完整时间线）
  - 流通盘兜底：emweb 十大股东（仅新条目拉取；老条目继承旧快照值，避免重复请求）

输出：
  - 回写 cb/index.html 的 const SNAPSHOT_PROGRESS=[...]; 段
  - 存档 cb/审核进度快照.json（供人工核对，不参与提交）

退出码：0=成功(可能未变化)；1=抓取失败或 HTML 结构异常（不覆盖旧数据）。
"""
import json
import math
import os
import re
import sys
import urllib.request
import urllib.error
import base64
from datetime import datetime, timezone, timedelta

JSL_URL = "https://www.jisilu.cn/webapi/cb/pre/"
JSL_REFERER = "https://www.jisilu.cn/web/data/cb/"
# 【2026-09-07 备用源】webapi/cb/pre/ 在 GitHub Actions(境外 IP)时常不可达，
# 而 data/cbnew/pre_list/ 与 fetch_pending.py 同源，云端实测长期可达。
# 字段差异：pre_list 无 progress 数字编号，需由 progress_nm 反推（见 nm_to_progress）。
JSL_URL_FALLBACK = "https://www.jisilu.cn/data/cbnew/pre_list/?___jsl=LST___t=0"
JSL_REFERER_FALLBACK = "https://www.jisilu.cn/data/cbnew/"
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
HTML = os.path.normpath(os.path.join(BASE_DIR, "..", "cb", "index.html"))
JSON_OUT = os.path.normpath(os.path.join(BASE_DIR, "..", "cb", "审核进度快照.json"))
CACHE = os.path.normpath(os.path.join(BASE_DIR, "..", "cb", "流通盘缓存.json"))
# 数据已外置为独立 JS 文件（与 index.html 解耦，CI 只改写这两个文件）
DATA_PROGRESS = os.path.normpath(os.path.join(BASE_DIR, "..", "cb", "data", "progress.js"))
DATA_PROG_CHANGED = os.path.normpath(os.path.join(BASE_DIR, "..", "cb", "data", "progress_changed.js"))
# 【2026-09-07 降频】审核进度一天 4 次太频繁且绝大部分是空跑（集思录每月新增到"同意注册"不到 10 家，
# 平均日增 <1 条）。改为每天只在两个窗口真正抓取：早盘前（对应原 08:30 班，放宽到 13:30 以容纳
# GitHub Actions 排队延迟，否则 08:30 班常被拖到中午反而错过"9 点前"）+ 晚间（对应原 21:00 班）。
# 其余运行直接秒退、不请求集思录、不覆盖数据。若要严格"9 点前"，把第一个窗口改为 (0, 0, 9, 0) 即可。
FETCH_WINDOWS = [
    (5, 0, 10, 0),     # 早盘前窗口（北京时间，对应原08:30班；放宽到10点以容纳GitHub排队延迟）
    (21, 0, 23, 59),   # 晚间窗口（北京时间，对应原21:00班）
]

# ===== FC 部署专用：GitHub 推送配置（由函数环境变量注入）=====
# DRY_RUN=1 时仍走本地文件（便于本地调试，不触碰 GitHub）；
# 生产环境设置 GH_TOKEN 后，旧值从 GitHub 当前文件读取、新值推送回 GitHub。
# 这正是根治「境外 IP 抓取冻结」的核心：函数在阿里云境内节点运行，
# 集思录 progress_dt 返回正常，且冷启动无本地状态，旧值比对一律以 GitHub 线上文件为准。
DRY_RUN = os.environ.get("DRY_RUN", "0") in ("1", "true", "True", "yes")
GH_REPO = os.environ.get("GH_REPO", "xianmeng872/cb-ration")
GH_BRANCH = os.environ.get("GH_BRANCH", "main")
GH_TOKEN = os.environ.get("GH_TOKEN", "")
USE_GITHUB = bool(GH_TOKEN) and not DRY_RUN


def _gh_headers(extra=None):
    h = {
        "Authorization": "Bearer " + GH_TOKEN,
        "Accept": "application/vnd.github+json",
        "User-Agent": "fc-fetch-progress",
    }
    if extra:
        h.update(extra)
    return h


def load_remote_text(path):
    """从 GitHub 当前文件读取文本内容，返回 (text, sha)。用于旧值比对与获取提交 sha。"""
    url = "https://api.github.com/repos/%s/contents/%s" % (GH_REPO, path)
    req = urllib.request.Request(url, headers=_gh_headers())
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.loads(r.read().decode("utf-8", errors="replace"))
    return base64.b64decode(d["content"]).decode("utf-8", errors="replace"), d.get("sha")


def push_to_github(path, content, msg):
    """更新/创建 GitHub 仓库文件（自动携带 sha 以支持覆盖提交）。"""
    sha = None
    try:
        _, sha = load_remote_text(path)
    except Exception:
        pass
    b64 = base64.b64encode(content.encode("utf-8")).decode("ascii")
    url = "https://api.github.com/repos/%s/contents/%s" % (GH_REPO, path)
    body = {"message": msg, "content": b64, "branch": GH_BRANCH}
    if sha:
        body["sha"] = sha
    req = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"),
        headers=_gh_headers({"Content-Type": "application/json"}),
        method="PUT")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8", errors="replace"))


def trigger_deploy():
    """推送完成后触发 Pages 重新部署，使新数据立刻上线。
    GitHub Actions 防递归：用 GITHUB_TOKEN 推送的 commit 不会自动触发 pages.yml，故需主动 dispatch。"""
    url = "https://api.github.com/repos/%s/actions/workflows/pages.yml/dispatches" % GH_REPO
    req = urllib.request.Request(
        url, data=json.dumps({"ref": GH_BRANCH}).encode("utf-8"),
        headers=_gh_headers({"Content-Type": "application/json"}),
        method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status


def beijing_now():
    return datetime.now(timezone.utc).astimezone(timezone(timedelta(hours=8)))


def in_fetch_window():
    """当前是否处于允许抓取的北京时间窗口。"""
    now = beijing_now()
    cur = now.hour * 60 + now.minute
    for (h1, m1, h2, m2) in FETCH_WINDOWS:
        if h1 * 60 + m1 <= cur <= h2 * 60 + m2:
            return True
    return False


EM_HOLDER = "https://emweb.securities.eastmoney.com/PC_HSF10/ShareholderResearch/PageAjax?code=CODE"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

# 实质比对字段（剔除 price 及由 price 推导的 _c，避免盘中浮动触发垃圾提交）
SIGNIFICANT = [
    "stockCode", "stockName", "code", "name", "progress", "progress_nm",
    "scale", "convertPrice", "perPre", "apply10", "ration_rt", "rating_cd",
    "progress_full", "accept_date", "progress_dt", "estFloat",
]


def em_code(sc):
    if not sc:
        return ""
    if sc[0] in "69":
        return "SH" + sc
    if sc[0] in "84":
        return "BJ" + sc
    return "SZ" + sc


def fetch(url, referer, timeout=30):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Referer": referer,
        "X-Requested-With": "XMLHttpRequest",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="replace")


def clean_nm(s):
    """清洗阶段名：去 HTML 标签（pre_list 的申购条目带 <span>）、压平空白。"""
    s = re.sub(r"<[^>]+>", " ", str(s or ""))
    return re.sub(r"\s+", " ", s).strip()


def nm_to_progress(nm):
    """由阶段名反推 progress 编号（pre_list 接口不带该字段）。

    编号口径与 update.mjs 的 order 表一致：
    10 董事会预案 / 20 股东大会通过 / 50 交易所受理 / 80 上市委通过 / 90 同意注册·申购 / 99 上市
    注意顺序：先判"上市委通过"（含"上市"二字），否则会被最后的"上市"误吞。
    """
    if "上市委通过" in nm:
        return "80"
    if "同意注册" in nm:
        return "90"
    if "交易所受理" in nm:
        return "50"
    if "股东大会通过" in nm:
        return "20"
    if "董事会预案" in nm:
        return "10"
    if "申购" in nm:
        return "90"
    if "上市" in nm:
        return "99"
    return ""


def _num(v):
    """pre_list 的数值字段可能是字符串，统一转 float；失败返回 None。"""
    if v in (None, "", "-"):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def load_from_webapi():
    """主源：webapi/cb/pre/（境内稳定，字段最全，带 progress 编号）。"""
    d = json.loads(fetch(JSL_URL, JSL_REFERER, timeout=20))
    data = d.get("data") or []
    if not data:
        raise ValueError("data 为空")
    return data, "webapi/cb/pre"


def load_from_prelist():
    """备用源：data/cbnew/pre_list/（GitHub 云端可达，与 fetch_pending.py 同源）。"""
    d = json.loads(fetch(JSL_URL_FALLBACK, JSL_REFERER_FALLBACK, timeout=20))
    rows = d.get("rows") or []
    out = []
    for r in rows:
        c = (r.get("cell") if isinstance(r, dict) else None) or r
        if not isinstance(c, dict):
            continue
        nm = clean_nm(c.get("progress_nm"))
        x = dict(c)
        x["progress_nm"] = nm
        x["progress"] = nm_to_progress(nm)
        # 字段口径对齐 webapi：数值化，避免字符串混入前端排序
        x["amount"] = _num(c.get("amount"))
        x["convert_price"] = _num(c.get("convert_price"))
        x["price"] = _num(c.get("price"))
        x["ration"] = _num(c.get("ration"))
        ap = _num(c.get("apply10"))
        x["apply10"] = int(ap) if ap is not None else None
        out.append(x)
    if not out:
        raise ValueError("rows 为空")
    return out, "data/cbnew/pre_list(备用源)"


def _normalize_item(x):
    """把两源的原始记录统一成比较用的四元组 (code, progress, progress_dt, nm)。"""
    c = (x.get("cell") if isinstance(x, dict) and "cell" in x else x) or {}
    if not isinstance(c, dict):
        return "", "", "", "", {}
    nm = clean_nm(c.get("progress_nm"))
    p = str(c.get("progress") or "").strip() or nm_to_progress(nm)
    dt = str(c.get("progress_dt") or "")[:10]
    return str(c.get("stock_id") or ""), p, dt, nm, c


def _keep(p, nm):
    """收录口径（与 main 的过滤一致）：排除已上市/申购中/日期过旧。"""
    if p == "99":
        return False
    if p == "90" and "申购" in nm:
        return False
    return True


def merge_sources(pairs):
    """把多源记录逐条合并：同一只股票取「进度日期更新」的那条。

    顺序以第一个源为主，只在出现全新股票时向后追加 —— 保证数据没变时
    顺序不变、不产生无意义提交。
    """
    merged = {}
    order = []
    for records, src in pairs:
        for x in records:
            code, p, dt, nm, c = _normalize_item(x)
            if not code or not _keep(p, nm):
                continue
            if dt and dt < "2025-01-01":
                continue
            if code not in merged:
                order.append(code)
                merged[code] = [c, dt, src]
            elif dt > merged[code][1]:
                merged[code] = [c, dt, src]
    return [merged[k][0] for k in order], {k: merged[k][2] for k in order}


def load_progress_data():
    """两源都抓，逐条取较新者；两源皆失败才判失败。

    【2026-09-07】此前只认 webapi 一个源，云端不可达时直接 return 1，
    被 workflow 的 continue-on-error 静默吞掉 → 审核进度连续多日冻结。

    【2026-09-17】只做「主源成功就用主源」还不够：实测 09-12~09-17 期间，
    GitHub Actions 侧 webapi 返回的行情字段是当天值、但 progress/progress_dt
    却冻结在 09-12（主源"成功"却内容滞后，脚本无从察觉），审核进度因此
    连续 5 天不更新；同期的 pre_list（与 fetch_pending 同源）在云端是新鲜的。
    故改为两源都抓、逐条按 progress_dt 取新，任一源新鲜即可补上。
    """
    errs = []
    pairs = []
    for loader in (load_from_webapi, load_from_prelist):
        try:
            data, src = loader()
            pairs.append((data, src))
        except Exception as e:
            errs.append("%s 失败: %r" % (getattr(loader, "__name__", "?"), e))
    if not pairs:
        return None, None, errs

    if len(pairs) == 1:
        return pairs[0][0], pairs[0][1], errs

    (d1, s1), (d2, s2) = pairs[0], pairs[1]
    max1 = max([_normalize_item(x)[2] for x in d1] or [""])
    max2 = max([_normalize_item(x)[2] for x in d2] or [""])
    if max1 != max2:
        errs.append("两源进度日期不一致：%s 到 %s，%s 到 %s（逐条取较新者）"
                    % (s1, max1 or "-", s2, max2 or "-"))
    merged, src_of = merge_sources(pairs)
    n2 = sum(1 for v in src_of.values() if v == s2)
    print("[双源] %s 进度到 %s / %s 进度到 %s → 合并 %d 条（其中 %d 条取自备用源）"
          % (s1, max1 or "-", s2, max2 or "-", len(merged), n2))
    return merged, "%s + %s(逐条取新)" % (s1, s2), errs


def get_lock_ratio(stock_code, cache):
    """emweb 十大股东锁定比例 = 持股≥5% 的股东合计（与 update.mjs 算法一致）。失败返回 None。"""
    if not stock_code:
        return None
    if stock_code in cache and cache[stock_code] is not None:
        return cache[stock_code]
    url = EM_HOLDER.replace("CODE", em_code(stock_code))
    for attempt in range(2):
        try:
            d = json.loads(fetch(url, "https://emweb.securities.eastmoney.com/", timeout=15))
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


def _ts(s):
    try:
        return datetime.strptime(str(s).strip()[:19], "%Y-%m-%d %H:%M:%S").timestamp()
    except Exception:
        try:
            return datetime.strptime(str(s).strip()[:10], "%Y-%m-%d").timestamp()
        except Exception:
            return 0


def _safe_int(v, default=-1):
    """安全转 int。

    【2026-09-04 防御】progress 字段可能为空串/None/非数字（集思录新债刚录入时常缺），
    直接 int() 会抛 ValueError → 脚本非 0 退出 → GitHub Actions step 失败 → 整条 job 中断，
    K线/待发债/审核进度三种数据一起停止更新。改为返回 default(-1)，永远不会中断流水线。
    """
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return default


def sig(obj, extra=None):
    """实质字段快照，用于比对。"""
    d = {k: obj.get(k) for k in SIGNIFICANT}
    if extra:
        d.update(extra)
    return d


def main():
    # 【2026-09-07 降频】非抓取窗口直接跳过（不请求、不覆盖，保持数据不变）
    if not in_fetch_window():
        bj = beijing_now().strftime("%H:%M")
        print("[跳过] 当前北京时间 %s 不在抓取窗口(早05:00-10:00 / 晚21:00-23:59)，本次不抓取" % bj)
        return 0

    # 1. 抓取集思录审核进度（主源失败自动切备用源，两源皆失败才判失败）
    data, source_used, src_errs = load_progress_data()
    if data is None:
        print("[ERROR] 集思录两个源都抓不到，不覆盖旧数据", file=sys.stderr)
        for e in src_errs:
            print("  -", e, file=sys.stderr)
        return 1
    for e in src_errs:
        print("[warn] 主源不可用，已降级:", e, file=sys.stderr)
    print("[数据源] %s，返回 %d 条" % (source_used, len(data)))

    # 2. 字段映射 + 过滤（与 update.mjs 一致）
    arr = []
    dropped = {"progress99": 0, "已申购": 0, "日期过旧": 0}   # 【2026-09-04】过滤明细，便于排障
    for x in data:
        progress_nm = clean_nm(x.get("progress_nm"))
        progress = str(x.get("progress") or "").strip()
        # 备用源(及主源缺字段时)由阶段名反推编号，保证过滤与排序口径一致
        if not progress:
            progress = nm_to_progress(progress_nm)
        if progress == "99":
            dropped["progress99"] += 1
            continue
        if progress == "90" and "申购" in progress_nm:
            dropped["已申购"] += 1
            continue
        progress_dt = str(x.get("progress_dt") or "")
        if progress_dt and progress_dt < "2025-01-01":
            dropped["日期过旧"] += 1
            continue
        o = {
            "stockCode": x.get("stock_id"),
            "stockName": x.get("stock_nm"),
            "code": x.get("bond_id") or "",
            "name": x.get("bond_nm") or "",
            "progress": progress,
            "progress_nm": progress_nm,
            "scale": x.get("amount"),
            "convertPrice": x.get("convert_price"),
            "price": x.get("price"),
            "perPre": float(x["ration"]) if x.get("ration") not in (None, "") else None,
            "apply10": int(x["apply10"]) if x.get("apply10") not in (None, "") else None,
            "ration_rt": x.get("ration_rt"),
            "rating_cd": x.get("rating_cd"),
            "progress_full": (x.get("progress_full") or "").strip(),
            "accept_date": x.get("accept_date"),
            "progress_dt": progress_dt or None,
        }
        arr.append(o)

    # 3. 计算 _c（与 update.mjs 一致）
    for o in arr:
        p, cp = o["price"], o["convertPrice"]
        if p is not None and cp:
            try:
                cv = float(p) / float(cp) * 100
                shares = None
                if o["apply10"] and o["apply10"] > 0:
                    shares = o["apply10"]
                elif o["perPre"] and o["perPre"] > 0:
                    shares = int(math.ceil(1000 / o["perPre"]))
                eff = o["perPre"] if (o["perPre"] and o["perPre"] > 0) else (1000 / shares if shares else None)
                need_shares = need_money = baiyuan = None
                if shares and p:
                    need_shares = shares
                    need_money = shares * float(p)
                    if eff:
                        baiyuan = eff * 100 / float(p)
                o["_c"] = {"cv": cv, "needShares": need_shares, "needMoney": need_money,
                           "baiyuan": baiyuan, "price": float(p), "estFloat": None}
            except Exception:
                o["_c"] = None
        else:
            o["_c"] = None

    # 4. 读取旧快照：estFloat 继承 + 名单比对基准
    # 生产环境（FC）：旧值从 GitHub 当前文件读取（函数冷启动无本地状态，不能读本地文件）；
    # 本地调试（DRY_RUN）：读本地数据文件。
    if USE_GITHUB:
        try:
            prog_txt, _ = load_remote_text("cb/data/progress.js")
        except Exception as e:
            print("[ERROR] 无法从 GitHub 读取旧 progress.js: %r" % e, file=sys.stderr)
            return 1
        try:
            chg_txt, _ = load_remote_text("cb/data/progress_changed.js")
        except Exception:
            chg_txt = ""
    else:
        if not os.path.exists(DATA_PROGRESS):
            print("[ERROR] 找不到 %s" % DATA_PROGRESS, file=sys.stderr)
            return 1
        prog_txt = open(DATA_PROGRESS, encoding="utf-8").read()
        chg_txt = open(DATA_PROG_CHANGED, encoding="utf-8").read() if os.path.exists(DATA_PROG_CHANGED) else ""
    m = re.search(r"window\.SNAPSHOT_PROGRESS\s*=\s*\[(.*?)\];", prog_txt, re.S)
    if not m:
        print("[ERROR] 未找到 SNAPSHOT_PROGRESS", file=sys.stderr)
        return 1
    old_arr = json.loads("[" + m.group(1) + "]")
    # 读取旧的 PROGRESS_CHANGED（广播条"最近变化"数据源，每日维护）
    old_changed = []
    m2 = re.search(r"window\.PROGRESS_CHANGED\s*=\s*(\[.*?\]);", chg_txt, re.S)
    old_changed = json.loads(m2.group(1)) if m2 else []
    old_by_code = {}
    old_sigs = []
    for o in old_arr:
        old_by_code[o.get("stockCode")] = o
        old_sigs.append(sig(o, {"estFloat": o.get("_c", {}).get("estFloat") if isinstance(o.get("_c"), dict) else None}))

    # 【2026-09-17】兜底：若某条（多为备用源）缺 progress_full，从旧快照继承，
    # 避免换源瞬间前端"进度全流程"空白。
    miss_pf = 0
    for o in arr:
        if (o.get("progress_full") or "").strip():
            continue
        old = old_by_code.get(o.get("stockCode"))
        if old and (old.get("progress_full") or ""):
            o["progress_full"] = old["progress_full"]
            miss_pf += 1
    if miss_pf:
        print("[双源] %d 条缺 progress_full，已从旧快照继承" % miss_pf)

    cache = {}
    if os.path.exists(CACHE):
        try:
            cache = json.load(open(CACHE, encoding="utf-8"))
        except Exception:
            cache = {}
        for k in [k for k, v in cache.items() if v is None]:
            del cache[k]

    # estFloat：老条目继承；新条目尝试 emweb
    # 【2026-09-04 防御】o["_c"] 可能为 None —— 当 price 或 convertPrice 缺失时，
    # 上面第 3 步会走 else 分支把 _c 置为 None。此时执行 o["_c"]["estFloat"]= 会抛
    # TypeError: 'NoneType' object does not support item assignment，导致脚本非 0 退出、
    # CI 整条 job 中断（K线/待发债/审核进度全部停更）。故先补空壳字典再赋值。
    new_count = 0
    for o in arr:
        if not isinstance(o.get("_c"), dict):
            o["_c"] = {"cv": None, "needShares": None, "needMoney": None,
                       "baiyuan": None, "price": None, "estFloat": None}
        old = old_by_code.get(o.get("stockCode"))
        if old and isinstance(old.get("_c"), dict) and old["_c"].get("estFloat") is not None:
            o["_c"]["estFloat"] = old["_c"]["estFloat"]
            continue
        lock = get_lock_ratio(o.get("stockCode"), cache)
        if lock is not None and o.get("scale"):
            o["_c"]["estFloat"] = round(float(o["scale"]) * (1 - lock / 100), 2)
            new_count += 1

    # 5. 实质变化比对（忽略 price / _c 推导值 / estFloat 已归入 SIGNIFICANT）
    new_sigs = [sig(o, {"estFloat": o["_c"].get("estFloat")
                        if isinstance(o.get("_c"), dict) else None}) for o in arr]
    # 数组顺序也纳入比对（进度分布变化会引起顺序变化，属实质变化）
    changed = new_sigs != old_sigs

    # 【2026-09-04】诊断日志：抓了多少、过滤掉多少、哪几只变了（以前全靠猜，出事定位不了）
    print("[诊断] 接口返回 %d 条 → 过滤(progress99=%d, 已申购=%d, 日期过旧=%d) → 保留 %d 条"
          % (len(data), dropped["progress99"], dropped["已申购"], dropped["日期过旧"], len(arr)))
    if changed:
        old_map = {o.get("stockCode"): o for o in old_arr}
        diff_lines = []
        for o in arr:
            old = old_map.get(o.get("stockCode"))
            if old is None:
                diff_lines.append("  + 新增 %s %s [%s %s]"
                                  % (o.get("stockCode"), o.get("stockName"),
                                     o.get("progress"), o.get("progress_nm")))
            elif str(old.get("progress")) != str(o.get("progress")):
                diff_lines.append("  ~ %s %s 阶段 %s(%s) → %s(%s)"
                                  % (o.get("stockCode"), o.get("stockName"),
                                     old.get("progress"), old.get("progress_nm"),
                                     o.get("progress"), o.get("progress_nm")))
            elif (old.get("progress_full") or "") != (o.get("progress_full") or ""):
                diff_lines.append("  ~ %s %s 时间线有更新(阶段未变)" % (o.get("stockCode"), o.get("stockName")))
        print("[诊断] 本次实质变化 %d 处:" % len(diff_lines))
        for ln in diff_lines[:30]:
            print(ln)
    else:
        print("审核进度无实质变化（仅价格浮动），保持文件不变，不产生提交")
        return 0

    # 6. 按进度降序 + 代码升序稳定排序，写回 HTML
    order = {"90": 0, "80": 1, "50": 2, "20": 3, "10": 4}
    arr.sort(key=lambda o: (order.get(o["progress"], 9), o["stockCode"] or ""))
    lit = "[\n" + ",\n".join(json.dumps(o, ensure_ascii=False, separators=(",", ":")) for o in arr) + "\n]"
    progress_js = "window.SNAPSHOT_PROGRESS = " + lit + ";\n"
    if USE_GITHUB:
        push_to_github("cb/data/progress.js", progress_js, "data: 审核进度快照自动更新(境内FC抓取)")
    else:
        with open(DATA_PROGRESS, "w", encoding="utf-8") as f:
            f.write(progress_js)
    # 维护 PROGRESS_CHANGED：对比本次抓取与上一次快照的阶段变化（广播条数据源，不依赖本地 localStorage）
    new_code_set = {o.get("stockCode") for o in arr}
    old_prog_map = {o.get("stockCode"): o.get("progress") for o in old_arr}
    today_str = datetime.now(timezone.utc).astimezone(timezone(timedelta(hours=8))).strftime("%Y-%m-%d")
    # 【飞哥规则 2026-08-30】公告只推「交易所受理(50)及以后」的进度变化；
    # 董事会预案(10)/股东大会通过(20)不公告。变化后新阶段 >=50 才记录。
    MIN_BROADCAST_PROG = 50
    new_changed = []
    for o in arr:
        k = o.get("stockCode")
        if not k:
            continue
        old_prog = old_prog_map.get(k)
        # 记录条件：① 新进名单（旧快照无此股） ② 阶段编号变化。
        # 且【新阶段 >=50】才记录（董事会预案/股东大会通过的变化不公告）
        # 【2026-09-04】int() 改 _safe_int()，空串/异常值返回 -1（<50 自然落选），不再中断 CI。
        if (old_prog is None or str(old_prog) != str(o.get("progress"))) \
                and _safe_int(o.get("progress")) >= MIN_BROADCAST_PROG:
            cd = o.get("progress_dt") or today_str
            new_changed.append({"stockCode": k, "stockName": o.get("stockName"), "changeDate": cd})
    for x in old_changed:
        k = x.get("stockCode")
        if k in new_code_set and not any(c["stockCode"] == k for c in new_changed):
            # 【飞哥规则】old 保留时也要求当前阶段 >=50（<50 的脏记录不再保留）
            cur_prog = next((o.get("progress") for o in arr if o.get("stockCode") == k), None)
            if _safe_int(cur_prog) >= MIN_BROADCAST_PROG:
                new_changed.append(x)
    # 【防膨胀】只保留最近 7 天的变化记录（前端广播条只显示 3 天窗口，7 天留冗余；
    # 过期的老记录不再累积，避免 PROGRESS_CHANGED 数组无限增长拖慢页面加载）
    cutoff7 = (datetime.now(timezone.utc).astimezone(timezone(timedelta(hours=8))) - timedelta(days=7)).strftime("%Y-%m-%d")
    new_changed = [c for c in new_changed if c.get("changeDate") and str(c.get("changeDate")) >= cutoff7]
    prog_changed_lit = "[" + ",".join(json.dumps(x, ensure_ascii=False) for x in new_changed) + "]"
    prog_changed_js = "window.PROGRESS_CHANGED = " + prog_changed_lit + ";\n"
    if USE_GITHUB:
        push_to_github("cb/data/progress_changed.js", prog_changed_js,
                       "data: 审核进度变化广播自动更新(境内FC抓取)")
        try:
            trigger_deploy()
            print("[部署] 已触发 Pages 重新部署，新数据即将上线")
        except Exception as e:
            print("[warn] 触发部署失败(数据已推送，下次 Actions 会兜底部署):", e, file=sys.stderr)
    else:
        with open(DATA_PROG_CHANGED, "w", encoding="utf-8") as f:
            f.write(prog_changed_js)

    # 7. 存档（仅本地调试模式；FC 无状态，旧值走 GitHub，不写本地）
    if not USE_GITHUB:
        try:
            json.dump(arr, open(JSON_OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        except Exception as e:
            print("[warn] 写快照json失败:", e, file=sys.stderr)
        try:
            json.dump(cache, open(CACHE, "w", encoding="utf-8"), ensure_ascii=False)
        except Exception:
            pass

    cnt = {}
    for o in arr:
        cnt[o["progress"]] = cnt.get(o["progress"], 0) + 1
    bj = datetime.now(timezone.utc).astimezone(timezone(timedelta(hours=8)))
    print("OK 写入 %d 条(新拉流通盘 %d 只) 进度分布:%s 时间:%s" % (len(arr), new_count, json.dumps(cnt, ensure_ascii=False), bj.strftime("%Y-%m-%d %H:%M")))
    return 0


def handler(event, context):
    """阿里云 FC Python runtime 入口：定时触发器调用。

    设计要点：
      - 函数仅做「抓取 + 推送 GitHub」，自身不持有状态（旧值比对以 GitHub 线上文件为准）；
      - 抓取在阿里云境内节点执行，集思录 progress_dt 返回正常，根治「境外 IP 进度冻结」；
      - 推送后主动 dispatch pages.yml 触发 Pages 重新部署，使新数据立刻上线。
    """
    try:
        rc = main()
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "exit": 1, "error": str(e)}
    return {"success": True, "exit": rc}


if __name__ == "__main__":
    sys.exit(main())

