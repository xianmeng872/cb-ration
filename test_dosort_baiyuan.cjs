// 测试 1: 验证审核进度页面 百元含权 硬分组是否生效
const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1280, height: 800 }
  });
  const page = await browser.newPage();

  // 拦截可能的网络错误
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  page.on('console', m => { if (m.type()==='error') console.log('[console.error]', m.text()); });

  // 加载本地 index.html
  const filePath = 'file:///' + path.resolve('index.html').replace(/\\/g, '/');
  await page.goto(filePath, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await new Promise(r => setTimeout(r, 1500));

  // 测试 doSort 的硬分组逻辑
  const result = await page.evaluate(() => {
    // 测试 1: 直接验证 doSort 硬分组
    const rows = [
      { _kind: 'progress', name: 'A-董事会预案', progress: 10, _c: { baiyuan: 15 } },
      { _kind: 'progress', name: 'B-股东大会', progress: 20, _c: { baiyuan: 12 } },
      { _kind: 'progress', name: 'C-交易所受理', progress: 50, _c: { baiyuan: 25 } },
      { _kind: 'progress', name: 'D-交易所受理2', progress: 50, _c: { baiyuan: 8 } },
      { _kind: 'progress', name: 'E-上市委', progress: 80, _c: { baiyuan: 30 } },
      { _kind: 'progress', name: 'F-同意注册', progress: 90, _c: { baiyuan: 20 } }
    ];
    const sorted = window.doSort(rows, { field: 'baiyuan', dir: 1 });
    return {
      sortedNames: sorted.map(r => r.name),
      sortedProgress: sorted.map(r => r.progress),
      sortedBaiyuan: sorted.map(r => r._c.baiyuan)
    };
  });

  console.log('=== doSort 硬分组测试（field=baiyuan, dir=1 降序）===');
  console.log('排序后:', JSON.stringify(result.sortedNames));
  console.log('progress:', JSON.stringify(result.sortedProgress));
  console.log('baiyuan:', JSON.stringify(result.sortedBaiyuan));

  // 测试 2: 验证 dir=-1 升序时硬分组是否仍然生效
  const result2 = await page.evaluate(() => {
    const rows = [
      { _kind: 'progress', name: 'A-董事会预案', progress: 10, _c: { baiyuan: 15 } },
      { _kind: 'progress', name: 'B-股东大会', progress: 20, _c: { baiyuan: 12 } },
      { _kind: 'progress', name: 'C-交易所受理', progress: 50, _c: { baiyuan: 25 } },
      { _kind: 'progress', name: 'D-交易所受理2', progress: 50, _c: { baiyuan: 8 } },
      { _kind: 'progress', name: 'E-上市委', progress: 80, _c: { baiyuan: 30 } },
      { _kind: 'progress', name: 'F-同意注册', progress: 90, _c: { baiyuan: 20 } }
    ];
    const sorted = window.doSort(rows, { field: 'baiyuan', dir: -1 });
    return sorted.map(r => `${r.name}(baiyuan=${r._c.baiyuan},progress=${r.progress})`);
  });
  console.log('\n=== doSort 硬分组测试（field=baiyuan, dir=-1 升序）===');
  console.log('排序后:', JSON.stringify(result2, null, 2));

  // 期望：早期(10/20) 永远在后面（不分升降序）
  // 升降序只影响组内排序

  await browser.close();
})();
