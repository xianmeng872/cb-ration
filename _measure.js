const puppeteer = require('C:/Users/丞哥飞呀/.workbuddy/binaries/node/workspace/node_modules/puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  await page.goto('file:///C:/Users/丞哥飞呀/cb-ration-new/index.html', { waitUntil: 'load', timeout: 30000 });
  await new Promise(r => setTimeout(r, 1500));

  // 切到“审核进度”Tab：找包含该文字的可点元素
  const clicked = await page.evaluate(() => {
    const els = [...document.querySelectorAll('button,div,[role=tab],.tab,a')];
    const t = els.find(e => e.textContent && e.textContent.trim().includes('审核进度'));
    if (t) { t.click(); return t.tagName + ' / ' + t.className; }
    return 'NOT_FOUND';
  });
  await new Promise(r => setTimeout(r, 800));

  const data = await page.evaluate(() => {
    const panel = document.getElementById('progressPanel');
    if (!panel) return { err: 'no progressPanel' };
    // 第一张卡片
    const card = panel.querySelector('.cb-card') || panel.querySelector('.card');
    if (!card) return { err: 'no card', panelHTML: panel.innerHTML.slice(0, 300) };
    const stats = card.querySelector('.cb-stats');
    if (!stats) return { err: 'no cb-stats', cardHTML: card.innerHTML.slice(0, 400) };
    const cells = [...stats.querySelectorAll('.s')];
    const out = cells.map((c, i) => {
      const label = c.querySelector('.l');
      const val = c.querySelector('.v') || c.querySelector('.tag') || c.querySelector('.cb-d');
      const r = val ? val.getBoundingClientRect() : null;
      const lr = label ? label.getBoundingClientRect() : null;
      return {
        idx: i,
        labelText: label ? label.textContent.trim() : '(none)',
        valText: val ? val.textContent.trim() : '(none)',
        labelTop: lr ? Math.round(lr.top) : null,
        valTop: r ? Math.round(r.top) : null,
        valH: r ? Math.round(r.height) : null
      };
    });
    return { cellCount: cells.length, statsTop: Math.round(stats.getBoundingClientRect().top), cells: out };
  });

  console.log('CLICKED_TAB:', clicked);
  console.log('ERRORS:', JSON.stringify(errors));
  console.log('DATA:', JSON.stringify(data, null, 2));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
