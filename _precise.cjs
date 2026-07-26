const puppeteer = require('C:/Users/丞哥飞呀/.workbuddy/binaries/node/workspace/node_modules/puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15');
  await page.goto('file:///C:/Users/丞哥飞呀/cb-ration-new/index.html', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 1200));
  await page.click('#tab-progress');
  await new Promise(r => setTimeout(r, 1000));

  const data = await page.evaluate(() => {
    const panel = document.getElementById('progressPanel');
    const item = panel.querySelector('.cb-item');
    const stats = item.querySelector('.cb-stats');
    const cells = [...stats.querySelectorAll('.s')];
    // 量每个格子内部所有子元素的精确盒模型
    return cells.map((ci, i) => {
      const cellR = ci.getBoundingClientRect();
      const label = ci.querySelector('.l');
      const valWrap = ci.querySelector('.v');   // 值的外层span
      // 值的实际内容（可能是文字或tag或cb-d）
      const valContent = valWrap ? (valWrap.querySelector('.tag') || valWrap.querySelector('.cb-d') || valWrap) : null;
      return {
        idx: i,
        labelText: label ? label.textContent.trim() : '-',
        valText: valContent ? valContent.textContent.trim() : '-',
        cell: { top: Math.round(cellR.top), left: Math.round(cellR.left), w: Math.round(cellR.width), h: Math.round(cellR.height) },
        label: label ? { top: Math.round(label.getBoundingClientRect().top), left: Math.round(label.getBoundingClientRect().left), w: Math.round(label.getBoundingClientRect().width), h: Math.round(label.getBoundingClientRect().height) } : null,
        valWrap: valWrap ? { top: Math.round(valWrap.getBoundingClientRect().top), left: Math.round(valWrap.getBoundingClientRect().left), w: Math.round(valWrap.getBoundingClientRect().width), h: Math.round(valWrap.getBoundingClientRect().height) } : null,
        valContent: valContent ? { top: Math.round(valContent.getBoundingClientRect().top), left: Math.round(valContent.getBoundingClientRect().left), w: Math.round(valContent.getBoundingClientRect().width), h: Math.round(valContent.getBoundingClientRect().height) } : null,
      };
    });
  });

  console.log(JSON.stringify(data, null, 2));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
