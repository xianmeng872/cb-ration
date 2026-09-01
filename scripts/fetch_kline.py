#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch_kline.py — 抓取 KLINE_SNAPSHOT 中全部股票日线并回写 index.html

背景:
  KLINE_SNAPSHOT 是手工维护的日线(不复权)快照, 用于计算"近5日/近20日/近3月"涨跌幅。
  此前停更于 2026-08-10, 导致全部股票涨跌幅基于旧视角(普遍虚高)。本脚本每日运行,
  把快照补全到最新交易日。

数据源(双源 + 并发, 规避单一源限流):
  主源 东方财富 push2his.eastmoney.com (不复权 fqt=0, 价格准确)
  备源 腾讯   web.ifzq.gtimg.cn      (前复权 qfqday, 服务端拉不受 CORS 限制, 国内外可达)
  注: 前端 cbkFetchKline 的浏览器端腾讯 fetch 因 CORS 被拦, 但此处是服务端 urllib 拉取不受限。

用法: python scripts/fetch_kline.py [--html cb/index.html]
依赖: 仅标准库
"""
import argparse
import concurrent.futures
import json
import re
import sys
import urllib.request

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
TIMEOUT = 8
EM_URL = ('https://push2his.eastmoney.com/api/qt/stock/kline/get'
          '?secid={secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f53'
          '&klt=101&fqt=0&end=20500101&lmt=250')
TX_URL = ('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
          '?param={market}{code},day,2020-01-01,2099-12-31,500,qfq')


def secid_of(code):
    return ('1.' if code[0] == '6' else '0.') + code


def fetch_em(code):
    url = EM_URL.format(secid=secid_of(code))
    req = urllib.request.Request(url, headers={
        'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/'})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        d = json.loads(resp.read().decode('utf-8'))
    kl = (d.get('data') or {}).get('klines') or []
    if not kl:
        raise ValueError('empty klines')
    return [{'date': k.split(',')[0], 'close': float(k.split(',')[1])} for k in kl]


def fetch_tx(code):
    market = 'sh' if code[0] == '6' else 'sz'
    url = TX_URL.format(market=market, code=code)
    req = urllib.request.Request(url, headers={
        'User-Agent': UA, 'Referer': 'https://gu.qq.com/'})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        d = json.loads(resp.read().decode('utf-8'))
    node = list((d.get('data') or {}).values())[0]
    arr = node.get('qfqday') or node.get('day') or []
    if not arr:
        raise ValueError('empty qfqday')
    return [{'date': r[0], 'close': float(r[2])} for r in arr]


def fetch_one(code):
    """主源东方财富(不复权), 失败立即转腾讯(前复权)。"""
    try:
        return fetch_em(code)
    except Exception:  # noqa: BLE001
        return fetch_tx(code)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--html', default='cb/index.html')
    args = ap.parse_args()
    with open(args.html, 'r', encoding='utf-8') as f:
        html = f.read()
    m = re.search(r'const KLINE_SNAPSHOT=(\{.*?\});', html, re.S)
    if not m:
        print('ERROR: 未找到 const KLINE_SNAPSHOT', file=sys.stderr)
        sys.exit(1)
    snapshot = json.loads(m.group(1))
    codes = list(snapshot.keys())
    print(f'共 {len(codes)} 只, 并发抓取日线(10线程)...')
    results, failed = {}, []
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
        futs = {ex.submit(fetch_one, c): c for c in codes}
        for fut in concurrent.futures.as_completed(futs):
            code = futs[fut]
            try:
                kl = fut.result()
                results[code] = kl
                chg5 = ((kl[-1]['close'] - kl[-6]['close']) / kl[-6]['close'] * 100
                        if len(kl) >= 6 else 0.0)
                print(f'  {code} OK 末:{kl[-1]["date"]} 收:{kl[-1]["close"]} 近5日:{chg5:+.2f}%')
            except Exception as e:  # noqa: BLE001
                results[code] = snapshot[code]
                failed.append(code)
                print(f'  {code} FAIL {e} (保留原值)')
    new_snap = {c: results.get(c, snapshot[c]) for c in codes}
    new_json = json.dumps(new_snap, ensure_ascii=False, separators=(',', ':'))
    new_html = (html[:m.start()] + 'const KLINE_SNAPSHOT=' + new_json + ';'
                + html[m.end():])
    with open(args.html, 'w', encoding='utf-8') as f:
        f.write(new_html)
    print(f'\n完成: 成功 {len(codes) - len(failed)} 只, 失败 {len(failed)} 只 {failed}')
    if failed and len(failed) == len(codes):
        sys.exit(2)


if __name__ == '__main__':
    main()
