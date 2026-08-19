# -*- coding: utf-8 -*-
"""本地 mock 测试 fetch_progress.py：沙箱访问不了集思录，用假数据验证回写/比对逻辑。"""
import json
import os
import re
import shutil
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(BASE, ".."))

# 拷贝一份临时 cb/index.html 用于测试
test_html = os.path.join(BASE, "test_cb_index.html")
src_html = os.path.join(REPO, "cb", "index.html")
shutil.copy(src_html, test_html)

import fetch_progress as fp

# 记录旧快照中的代码集合（用于判断"新条目"）
_old_html = open(src_html, encoding="utf-8").read()
_m = re.search(r"const SNAPSHOT_PROGRESS=\[(.*?)\];", _old_html, re.S)
fp._old_codes_for_test = {x["stockCode"] for x in json.loads("[" + _m.group(1) + "]")}

# 替换路径指向测试副本
fp.HTML = test_html
fp.JSON_OUT = os.path.join(BASE, "test_审核进度快照.json")
fp.CACHE = os.path.join(BASE, "test_流通盘缓存.json")

# mock 集思录响应：几条真实形状的数据 + 申菱环境已过会
MOCK = {"data": [
    {"stock_id": "603339", "stock_nm": "四方科技", "bond_id": "", "bond_nm": "", "progress": "90",
     "progress_nm": "同意注册", "amount": 10.23, "convert_price": 12.58, "price": 14.01,
     "ration": None, "apply10": 303, "ration_rt": None, "rating_cd": None,
     "progress_full": "2024-01-30 董事会预案\n2026-01-01 股东大会通过\n2026-01-21 交易所受理\n2026-04-02 上市委通过\n2026-05-21 同意注册",
     "accept_date": "2026-01-21", "progress_dt": "2026-05-21"},
    {"stock_id": "301018", "stock_nm": "申菱环境", "bond_id": "", "bond_nm": "", "progress": "80",
     "progress_nm": "上市委通过", "amount": 10, "convert_price": 84.17, "price": 93.57,
     "ration": None, "apply10": 375, "ration_rt": None, "rating_cd": None,
     "progress_full": "2025-11-25 董事会预案\n2026-02-25 股东大会通过\n2026-04-10 交易所受理\n2026-08-18 上市委通过",
     "accept_date": "2026-04-10", "progress_dt": "2026-08-18"},
    {"stock_id": "601717", "stock_nm": "中创智领", "bond_id": "", "bond_nm": "", "progress": "50",
     "progress_nm": "交易所受理", "amount": 60, "convert_price": 7.5, "price": 7.2,
     "ration": None, "apply10": 2000, "ration_rt": None, "rating_cd": None,
     "progress_full": "2026-01-10 董事会预案\n2026-02-10 股东大会通过\n2026-06-01 交易所受理",
     "accept_date": "2026-06-01", "progress_dt": "2026-06-01"},
    # 已排期申购的应被过滤
    {"stock_id": "301628", "stock_nm": "强达电路", "bond_id": "123456", "bond_nm": "强达转债", "progress": "90",
     "progress_nm": "2026-08-19申购<br><span>申购代码 371628</span>", "amount": 5.5, "convert_price": 76.31, "price": 82.36,
     "ration": 1.1, "apply10": 138, "ration_rt": None, "rating_cd": None,
     "progress_full": "2025-12-27 董事会预案\n2026-01-13 股东大会通过\n2026-02-12 交易所受理\n2026-06-12 上市委通过\n2026-07-27 同意注册",
     "accept_date": "2026-02-12", "progress_dt": "2026-08-19"},
    # 已上市 99 应被过滤
    {"stock_id": "600642", "stock_nm": "申能股份", "bond_id": "110103", "bond_nm": "申能转债", "progress": "99",
     "progress_nm": "已上市", "amount": 20, "convert_price": 8.74, "price": 8.37,
     "ration": None, "apply10": 2451, "ration_rt": None, "rating_cd": None,
     "progress_full": "x", "accept_date": "2025-10-16", "progress_dt": "2026-07-24"},
]}

fp.fetch = lambda url, referer, timeout=30: json.dumps(MOCK, ensure_ascii=False)
fp.get_lock_ratio = lambda sc, cache: (60.0 if sc == "301018" else 50.0)


def run_tests():
    print("=== 第一轮：应检测到实质变化并重写 ===")
    rc = fp.main()
    print("exit:", rc)

    html = open(test_html, encoding="utf-8").read()
    m = re.search(r"const SNAPSHOT_PROGRESS=\[(.*?)\];", html, re.S)
    arr = json.loads("[" + m.group(1) + "]")
    print("新快照条数:", len(arr), "（期望 3：四方/申菱/中创，强达被90含申购过滤、申能被99过滤）")
    sl = [x for x in arr if x["stockCode"] == "301018"]
    print("申菱环境:", json.dumps(sl[0], ensure_ascii=False)[:200] if sl else "缺失!")
    assert len(arr) == 3, "过滤逻辑错误: %d" % len(arr)
    assert sl and sl[0]["progress"] == "80" and sl[0]["progress_nm"] == "上市委通过", "申菱状态未更新"
    assert sl[0]["_c"]["estFloat"] == 5.13, "老条目estFloat应继承: %s" % sl[0]["_c"]["estFloat"]
    assert [x["progress"] for x in arr] == ["90", "80", "50"], "排序错误: %s" % [x["progress"] for x in arr]
    zc = [x for x in arr if x["stockCode"] == "601717"]
    if zc and "601717" not in fp._old_codes_for_test:
        assert zc[0]["_c"]["estFloat"] == 30.0, "新条目estFloat应拉取: %s" % zc[0]["_c"]["estFloat"]

    print("\n=== 第二轮：同数据应无变化不重写 ===")
    before = open(test_html, encoding="utf-8").read()
    rc2 = fp.main()
    print("exit:", rc2)
    after = open(test_html, encoding="utf-8").read()
    assert before == after, "无变化时不应重写文件!"
    print("文件未变 ✓")

    print("\n=== 第三轮：只有价格浮动应视为无变化 ===")
    MOCK["data"][1]["price"] = 95.1  # 仅改申菱正股价
    rc3 = fp.main()
    after3 = open(test_html, encoding="utf-8").read()
    assert after3 == after, "价格浮动不应触发重写!"
    print("价格浮动未触发提交 ✓")

    print("\n=== 第四轮：审核阶段变化（上市委通过→同意注册）应触发 ===")
    MOCK["data"][1]["progress"] = "90"
    MOCK["data"][1]["progress_nm"] = "同意注册"
    MOCK["data"][1]["progress_full"] = MOCK["data"][1]["progress_full"] + "\n2026-08-19 同意注册"
    MOCK["data"][1]["progress_dt"] = "2026-08-19"
    rc4 = fp.main()
    after4 = open(test_html, encoding="utf-8").read()
    assert after4 != after, "阶段变化应触发重写!"
    arr4 = json.loads("[" + re.search(r"const SNAPSHOT_PROGRESS=\[(.*?)\];", after4, re.S).group(1) + "]")
    sl4 = [x for x in arr4 if x["stockCode"] == "301018"][0]
    assert sl4["progress"] == "90" and sl4["progress_nm"] == "同意注册", "阶段未更新"
    print("阶段变化已触发重写 ✓")

    print("\n全部测试通过 ✓")


if __name__ == "__main__":
    run_tests()
