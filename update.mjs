// 云版本：使用相对路径，运行于 cb-ration-repo 根目录
import fs from 'fs';

const HTML = './index.html';
const CACHE = './流通盘缓存.json'; // 逐只落盘，断点续跑 + 复用，避免东财限流
const JSL = 'https://www.jisilu.cn/webapi/cb/pre/';
// 东财 F10 网页版股东研究接口（与 datacenter 不同主机，基本不限流）
const EM_HOLDER = 'https://emweb.securities.eastmoney.com/PC_HSF10/ShareholderResearch/PageAjax?code=CODE';

// 6位代码 → emweb 代码(SZ/SH/BJ)
function emCode(sc) {
  if (!sc) return '';
  if (sc[0] === '6' || sc[0] === '9') return 'SH' + sc;
  if (sc[0] === '8' || sc[0] === '4') return 'BJ' + sc;
  return 'SZ' + sc;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 读取已缓存的锁定比例
let LOCK_CACHE = {};
if (fs.existsSync(CACHE)) {
  try { LOCK_CACHE = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch (e) { LOCK_CACHE = {}; }
}
function saveCache() { fs.writeFileSync(CACHE, JSON.stringify(LOCK_CACHE, null, 0)); }

// 拉正股十大股东 → 返回受限主体锁定比例(0-100)，失败返回 null。
// 锁定比例 = 十大股东中持股≥5% 的股东合计（持股≥5%的实际控制人/一致行动人已包含在内；<5%的董监高影响极小，忽略）。
// 流通盘 = 总规模 × (1 − 锁定比例)。
async function getLockRatio(stockCode) {
  if (!stockCode) return null;
  if (LOCK_CACHE[stockCode] !== undefined && LOCK_CACHE[stockCode] !== null) return LOCK_CACHE[stockCode]; // 仅命中有效缓存；null视为未算，重试
  const url = EM_HOLDER.replace('CODE', emCode(stockCode));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://emweb.securities.eastmoney.com/' } });
      const d = await r.json();
      const sdhg = d.sdgd; // 十大股东
      if (sdhg && sdhg.length) {
        const times = sdhg.map(x => x.END_DATE ? new Date(String(x.END_DATE).replace(' ', 'T')).getTime() : 0).filter(t => t > 0);
        if (times.length) {
          const maxT = Math.max(...times);
          const latest = sdhg.filter(x => x.END_DATE && new Date(String(x.END_DATE).replace(' ', 'T')).getTime() === maxT);
          const seen = new Set(); const uniq = [];
          latest.forEach(x => { const k = x.HOLDER_NAME; if (k && !seen.has(k)) { seen.add(k); uniq.push(x); } });
          const lock = uniq.filter(x => parseFloat(x.HOLD_NUM_RATIO) >= 5)
            .reduce((s, x) => s + (parseFloat(x.HOLD_NUM_RATIO) || 0), 0);
          const v = +(lock > 100 ? 100 : lock).toFixed(2);
          LOCK_CACHE[stockCode] = v; saveCache();
          return v;
        }
      }
      await sleep(800);
    } catch (e) {
      console.error('  ' + stockCode + ' 尝试' + (attempt + 1) + '失败: ' + e.message);
      await sleep(800);
    }
  }
  return null;
}

(async () => {
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

  const filtered = arr.filter(o => {
    if (o.progress === '99') return false;
    if (o.progress === '90' && o.progress_nm && o.progress_nm.indexOf('申购') >= 0) return false;
    if (o.progress_dt && o.progress_dt < '2025-01-01') return false; // 25年以前发债，剔除
    return true;
  });

  console.log('拉取 ' + filtered.length + ' 只正股股东数据算流通盘... (已缓存 ' + Object.keys(LOCK_CACHE).length + ' 只)');
  for (const o of filtered) {
    if (o._c == null || !o.scale) continue;
    const lock = await getLockRatio(o.stockCode);
    if (lock != null) o._c.estFloat = +(o.scale * (1 - lock / 100)).toFixed(2);
    await sleep(1500);
  }
  const withFloat = filtered.filter(o => o._c && o._c.estFloat != null).length;

  let html = fs.readFileSync(HTML, 'utf8');
  const re = /const SNAPSHOT_PROGRESS=\[[\s\S]*?\];/;
  if (!re.test(html)) { console.error('HTML 未找到 SNAPSHOT_PROGRESS'); process.exit(1); }
  const lit = '[\n' + filtered.map(o => JSON.stringify(o)).join(',\n') + '\n]';
  html = html.replace(re, 'const SNAPSHOT_PROGRESS=' + lit + ';');

  const pendMatch = html.match(/const SNAPSHOT_PEND=(\[[\s\S]*?\]);/);
  if (pendMatch) {
    const pend = JSON.parse(pendMatch[1]);
    console.log('待发债 ' + pend.length + ' 只，补流通盘...');
    for (const b of pend) {
      if (!b.stockCode || b.scale == null) continue;
      const lock = await getLockRatio(b.stockCode);
      if (lock != null) {
        b._c = b._c || {};
        b._c.estFloat = +(b.scale * (1 - lock / 100)).toFixed(2);
      }
      await sleep(1500);
    }
    const pendLit = '[\n' + pend.map(o => JSON.stringify(o)).join(',\n') + '\n]';
    html = html.replace(/const SNAPSHOT_PEND=\[[\s\S]*?\];/, 'const SNAPSHOT_PEND=' + pendLit + ';');
  }

  fs.writeFileSync(HTML, html);

  const cnt = {};
  filtered.forEach(o => cnt[o.progress] = (cnt[o.progress] || 0) + 1);
  console.log('OK 写入 ' + filtered.length + ' 条(流通盘已算 ' + withFloat + ' 只)。进度分布:', JSON.stringify(cnt));
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
