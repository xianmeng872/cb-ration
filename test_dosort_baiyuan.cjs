// 实测：审核进度页面，按百元含权排序时，董事会预案/股东大会通过 是否排到后面
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
  const filePath = 'file:///' + path.resolve('index.html').replace(/\\/g, '/');
  await page.goto(filePath, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await new Promise(r => setTimeout(r, 1500));

  // 调用 doSort 测试 6 条审核进度（覆盖 10/20/50/80/90）
  const result = await page.evaluate(() => {
    // 真实数据：百元含权高的交易所受理 + 高的上市委 + 低的董事会预案 + 低的股东大会
    const rows = [
      // progress=10 董事会预案 (早期)
      { _kind: 'progress', name: 'A.弘景光电', progress: 10, _c: { baiyuan: 50 } },
      { _kind: 'progress', name: 'A2.某早期高', progress: 10, _c: { baiyuan: 80 } },
      // progress=20 股东大会 (早期)
      { _kind: 'progress', name: 'B.中谷物流', progress: 20, _c: { baiyuan: 30 } },
      { _kind: 'progress', name: 'B2.某股东大会高', progress: 20, _c: { baiyuan: 60 } },
      // progress=50 交易所受理 (非早期)
      { _kind: 'progress', name: 'C.强力', progress: 50, _c: { baiyuan: 20 } },
      { _kind: 'progress', name: 'C2.某受理高', progress: 50, _c: { baiyuan: 40 } },
      // progress=80 上市委通过 (非早期)
      { _kind: 'progress', name: 'D.长芯', progress: 80, _c: { baiyuan: 15 } },
      // progress=90 同意注册 (非早期)
      { _kind: 'progress', name: 'E.中富', progress: 90, _c: { baiyuan: 10 } }
    ];
    const sortedDesc = window.doSort(rows, { field: 'baiyuan', dir: 1 });
    const sortedAsc = window.doSort(rows, { field: 'baiyuan', dir: -1 });
    return {
      desc: sortedDesc.map(r => `${r.name} [progress=${r.progress}, baiyuan=${r._c.baiyuan}]`),
      asc: sortedAsc.map(r => `${r.name} [progress=${r.progress}, baiyuan=${r._c.baiyuan}]`)
    };
  });

  console.log('=== 审核进度 百元含权 降序（dir=1）===');
  result.desc.forEach((s, i) => console.log(`${i+1}. ${s}`));
  console.log('\n=== 审核进度 百元含权 升序（dir=-1）===');
  result.asc.forEach((s, i) => console.log(`${i+1}. ${s}`));

  // 验证：早期(progress=10/20) 永远在最后
  const descEarlyIdx = result.desc.findIndex(s => s.includes('progress=10') || s.includes('progress=20'));
  const descNonEarlyIdx = result.desc.findLastIndex ? result.desc.findLastIndex(s => s.includes('progress=5') || s.includes('progress=8') || s.includes('progress=9')) : -1;
  // 简单验证：desc 数组中所有 progress=10/20 都在 progress=50/80/90 之后
  let descCorrect = true, ascCorrect = true;
  for (let i = 0; i < result.desc.length; i++) {
    const s = result.desc[i];
    if (s.includes('progress=10') || s.includes('progress=20')) {
      // 检查 i 之后还有没有 progress=50/80/90
      for (let j = i+1; j < result.desc.length; j++) {
        if (result.desc[j].match(/progress=[589]/)) { descCorrect = false; break; }
      }
    }
  }
  for (let i = 0; i < result.asc.length; i++) {
    const s = result.asc[i];
    if (s.includes('progress=10') || s.includes('progress=20')) {
      for (let j = i+1; j < result.asc.length; j++) {
        if (result.asc[j].match(/progress=[589]/)) { ascCorrect = false; break; }
      }
    }
  }
  console.log(`\n降序硬分组正确：${descCorrect ? '✅' : '❌'}`);
  console.log(`升序硬分组正确：${ascCorrect ? '✅' : '❌'}`);

  await browser.close();
})();
