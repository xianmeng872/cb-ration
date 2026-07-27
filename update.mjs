import fs from 'fs';

const HTML = './index.html';
const JSON_OUT = './审核进度快照.json';
const KLINE_OUT = './KLINE_DATA.json';
const CACHE = './流通盘缓存.json';
const JSL = 'https://www.jisilu.cn/webapi/cb/pre/';
// emweb 网页版股东接口（稳定不限流，返回十大股东+持股比例）
const EM_HOLDER = 'https://emweb.securities.eastmoney.com/PC_HSF10/ShareholderResearch/PageAjax?code=CODE';

// 6位代码 → emweb 代码(SZ/SH/BJ)
function emCode(sc) {
  if (!sc) return '';
  if (sc[0] === '6' || sc[0] === '9') return 'SH' + sc;
  if (sc[0] === '8' || sc[0] === '4') return 'BJ' + sc;
  return 'SZ' + sc;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

let LOCK_CACHE = {};
if (fs.existsSync(CACHE)) {
  try { LOCK_CACHE = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch (e) { LOCK_CACHE = {}; }
  // 清除残留null
  let dirty = false;
  for (const k of Object.keys(LOCK_CACHE)) { if (LOCK_CACHE[k] === null) { delete LOCK_CACHE[k]; dirty = true; } }
  if (dirty) saveCache();
}
function saveCache() { fs.writeFileSync(CACHE, JSON.stringify(LOCK_CACHE, null, 0)); }

/**
 * 拉正股十大股东 → 返回受限主体锁定比例(0-100)，失败返回 null。
 *
 * 当前数据源：emweb 十大股东（稳定不限流）
 * 算法：锁定比例 = 十大股东中持股≥5% 的合计
 *
 * ⚠️ 已知局限：emweb 无 IS_DJG(董监高)/IS_SJKZR(实控人) 字段，
 *    因此董监高（含配偶/父母/子女）的持股未计入锁定比例。
 *    这部分通常额外贡献 0.5-3% 的锁定，实际流通盘可能比显示值略小。
 *    后续若 datacenter 限流窗口放开，可切换到含 IS_DJG 的完整算法。
 *
 * 流通盘 = 总规模 × (1 − 锁定比例)，标注"预"表示估算值。
 */
async function getLockRatio(stockCode) {
  if (!stockCode) return null;
  if (LOCK_CACHE[stockCode] !== undefined && LOCK_CACHE[stockCode] !== null) return LOCK_CACHE[stockCode];
  const url = EM_HOLDER.replace('CODE', emCode(stockCode));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://emweb.securities.eastmoney.com/' } });
      const d = await r.json();
      const sdhg = d.sdgd;
      if (!sdhg || !sdhg.length) { await sleep(800); continue; }
      // 取最新报告期
      const times = sdhg.map(x => x.END_DATE ? new Date(String(x.END_DATE).replace(' ', 'T')).getTime() : 0).filter(t => t > 0);
      if (!times.length) { await sleep(800); continue; }
      const maxT = Math.max(...times);
      const latest = sdhg.filter(x => x.END_DATE && new Date(String(x.END_DATE).replace(' ', 'T')).getTime() === maxT);
      // 按股东名去重
      const seen = new Set(); const uniq = [];
      latest.forEach(x => { const k = x.HOLDER_NAME; if (k && !seen.has(k)) { seen.add(k); uniq.push(x); } });
      // 锁定比例 = 十大股东中持股≥5% 的合计
      const lock = uniq.filter(x => parseFloat(x.HOLD_NUM_RATIO) >= 5)
        .reduce((s, x) => s + (parseFloat(x.HOLD_NUM_RATIO) || 0), 0);
      // 无≥5%股东 → 锁定比例按 0（全流通），缓存并返回 0，不再重试
      if (lock <= 0) { LOCK_CACHE[stockCode] = 0; saveCache(); return 0; }
      const v = +(lock > 100 ? 100 : lock).toFixed(2);
      LOCK_CACHE[stockCode] = v; saveCache();
      return v;
    } catch (e) {
      console.error('  ' + stockCode + ' 尝试' + (attempt + 1) + '失败: ' + e.message);
      await sleep(800);
    }
  }
  return null;
}

/**
 * 拉新浪日K（真实成交价，不复权）
 * scale=240 即日线，datalen=90 约 4 个月交易日，返回后过滤最近 3 个自然月
 */
async function fetchSinaKline(stockCode) {
  if (!stockCode || !/^\d{6}$/.test(stockCode)) return null;
  const prefix = (stockCode[0] === '6' || stockCode[0] === '9') ? 'sh' : 'sz';
  const symbol = prefix + stockCode;
  const url = 'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=' + symbol + '&scale=240&ma=5&datalen=90';
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn/' } });
    const buf = await r.arrayBuffer();
    const text = new TextDecoder('gbk').decode(buf);
    const arr = JSON.parse(text);
    if (!arr || !arr.length) return null;
    const end = new Date(), start = new Date();
    start.setMonth(start.getMonth() - 3);
    const pad = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const startStr = pad(start);
    const filtered = arr.filter(x => x.day && x.day >= startStr).map(x => ({ date: x.day, close: +(x.close) }));
    return filtered.length >= 5 ? filtered : null;
  } catch (e) {
    console.error('  K线 ' + stockCode + ' 失败: ' + e.message);
    return null;
  }
}

(async () => {
  // ===== 1. 审核进度（集思录） =====
  const r = await fetch(JSL, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.jisilu.cn/web/data/cb/' } });
  const d = await r.json();
  if (!d.data || !d.data.length) { console.error('集思录接口无数据'); process.exit(1); }

  const arr = d.data.map(x => ({
    stockCode: x.stock_id, stockName: x.stock_nm, code: x.bond_id || '', name: x.bond_nm || '',
    progress: String(x.progress),
    progress_nm: (x.progress_nm || '').replace(/<br>/g, ' ').replace(/\s+/g, ' ').trim(),
    scale: x.amount, convertPrice: x.convert_price, price: x.price,
    perPre: x.ration != null ? parseFloat(x.ration) : null,
    apply10: x.apply10 != null ? parseInt(x.apply10) : null,
    ration_rt: x.ration_rt, rating_cd: x.rating_cd,
    progress_full: (x.progress_full || '').trim(),
    accept_date: x.accept_date, progress_dt: x.progress_dt
  }));

  arr.forEach(o => {
    if (o.price != null && o.convertPrice) {
      const cv = o.price / o.convertPrice * 100;
      const shares = (o.apply10 && o.apply10 > 0) ? o.apply10 : (o.perPre && o.perPre > 0 ? Math.ceil(1000 / o.perPre) : null);
      const effPerPre = (o.perPre && o.perPre > 0) ? o.perPre : (shares ? 1000 / shares : null);
      let needShares = null, needMoney = null, baiyuan = null;
      if (shares && o.price) {
        needShares = shares;
        needMoney = shares * o.price;
        if (effPerPre) baiyuan = effPerPre * 100 / o.price;
      }
      o._c = { cv, needShares, needMoney, baiyuan, price: o.price };
    } else o._c = null;
  });

  // 数据源层面剔除：仅剔除已上市(99) + 25年以前发债(长期停滞预案)，申购阶段(90)保留显示
  const filtered = arr.filter(o => {
    if (o.progress === '99') return false;
    if (o.progress_dt && o.progress_dt < '2025-01-01') return false;
    return true;
  });

  // 批量拉股东算流通盘（emweb 稳定，300ms间隔即可）
  console.log('拉取 ' + filtered.length + ' 只正股股东数据算流通盘... (已缓存 ' + Object.keys(LOCK_CACHE).length + ' 只)');
  let ok = 0, fail = 0;
  for (let idx = 0; idx < filtered.length; idx++) {
    const o = filtered[idx];
    if (o._c == null || !o.scale) continue;
    const lock = await getLockRatio(o.stockCode);
    if (lock != null) { o._c.estFloat = +(o.scale * (1 - lock / 100)).toFixed(2); ok++; }
    else fail++;
    if ((idx + 1) % 15 === 0 || idx === filtered.length - 1) {
      console.error('[' + (idx + 1) + '/' + filtered.length + '] 成功' + ok + ' 失败' + fail);
    }
    await sleep(300); // emweb 不限流，300ms足够
  }

  let html = fs.readFileSync(HTML, 'utf8');
  const re = /const SNAPSHOT_PROGRESS=\[[\s\S]*?\];/;
  if (!re.test(html)) { console.error('HTML 未找到 SNAPSHOT_PROGRESS'); process.exit(1); }
  const lit = '[\n' + filtered.map(o => JSON.stringify(o)).join(',\n') + '\n]';
  html = html.replace(re, 'const SNAPSHOT_PROGRESS=' + lit + ';');

  // ===== 2. 待发债（读现有 SNAPSHOT_PEND，补 estFloat） =====
  const pendMatch = html.match(/const SNAPSHOT_PEND=(\[[\s\S]*?\]);/);
  if (pendMatch) {
    const pend = JSON.parse(pendMatch[1]);
    console.log('待发债 ' + pend.length + ' 只，补流通盘...');
    for (const b of pend) {
      if (!b.stockCode || b.scale == null) continue;
      const lock = await getLockRatio(b.stockCode);
      if (lock != null) { b._c = b._c || {}; b._c.estFloat = +(b.scale * (1 - lock / 100)).toFixed(2); }
      await sleep(300);
    }
    const pendLit = '[\n' + pend.map(o => JSON.stringify(o)).join(',\n') + '\n]';
    html = html.replace(/const SNAPSHOT_PEND=\[[\s\S]*?\];/, 'const SNAPSHOT_PEND=' + pendLit + ';');
  }

  // ===== 3. 抓取近3个月不复权日K（供正股走势使用，与行情软件真实成交价口径一致） =====
  const klineCodes = new Set();
  filtered.forEach(o => { if (o.stockCode) klineCodes.add(o.stockCode); });
  if (pendMatch) {
    const pend = JSON.parse(pendMatch[1]);
    pend.forEach(b => { if (b.stockCode) klineCodes.add(b.stockCode); });
  }
  console.log('拉取 ' + klineCodes.size + ' 只正股日K（新浪不复权）...');
  const klineData = {};
  let klineOk = 0, klineFail = 0;
  for (const sc of klineCodes) {
    const d = await fetchSinaKline(sc);
    if (d && d.length >= 5) { klineData[sc] = d; klineOk++; }
    else { klineFail++; }
    await sleep(150);
  }
  const klineLit = JSON.stringify(klineData);
  html = html.replace(/const KLINE_SNAPSHOT=\{[\s\S]*?\};/, 'const KLINE_SNAPSHOT=' + klineLit + ';');
  fs.writeFileSync(KLINE_OUT, JSON.stringify(klineData, null, 1));
  console.log('日K抓取完成：成功 ' + klineOk + ' 只，失败 ' + klineFail + ' 只');

  fs.writeFileSync(HTML, html);
  fs.writeFileSync(JSON_OUT, JSON.stringify(filtered, null, 1));

  const cnt = {};
  filtered.forEach(o => cnt[o.progress] = (cnt[o.progress] || 0) + 1);
  console.log('OK 写入 ' + filtered.length + ' 条(流通盘已算 ' + ok + ' 只, 失败 ' + fail + ' 只) + 待发债流通盘已补。进度分布:', JSON.stringify(cnt));
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
