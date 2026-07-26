const puppeteer = require('C:/Users/丞哥飞呀/.workbuddy/binaries/node/workspace/node_modules/puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1');
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERR: ' + e.message));

  await page.goto('file:///C:/Users/丞哥飞呀/cb-ration-new/index.html', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 1200));

  await page.click('#tab-progress');
  await new Promise(r => setTimeout(r, 1000));

  const data = await page.evaluate(() => {
    const panel = document.getElementById('progressPanel');
    const item = panel.querySelector('.cb-item');
    if (!item) return { err: 'no cb-item', panelHTML: panel.innerHTML.slice(0, 200) };
    const stats = item.querySelector('.cb-stats');
    const cells = [...stats.querySelectorAll('.s')];
    const out = cells.map((c, i) => {
      const label = c.querySelector('.l');
      const val = c.querySelector('.v') || c.querySelector('.tag') || c.querySelector('.cb-d');
      const r = val ? val.getBoundingClientRect() : null;
      const lr = label ? label.getBoundingClientRect() : null;
      return {
        idx: i,
        label: label ? label.textContent.trim() : '(none)',
        val: val ? val.textContent.trim() : '(none)',
        labelTop: lr ? Math.round(lr.top) : null,
        valTop: r ? Math.round(r.top) : null,
        valH: r ? Math.round(r.height) : null
      };
    });
    // 取第一张卡片整体
    const cardRect = item.getBoundingClientRect();
    return { cellCount: cells.length, cardTop: Math.round(cardRect.top), cellW: Math.round(cardRect.width), cells: out };
  });

  console.log('ERRORS:', JSON.stringify(errors));
  console.log('DATA:', JSON.stringify(data, null, 2));

  // 截图第一张卡片
  const item = await page.$('#progressPanel .cb-item');
  if (item) { await item.screenshot({ path: 'C:/Users/丞哥飞呀/cb-ration-new/_card.png' }); console.log('SCREENSHOT_OK'); }

  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
