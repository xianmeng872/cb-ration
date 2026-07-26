const puppeteer = require('C:/Users/丞哥飞呀/.workbuddy/binaries/node/workspace/node_modules/puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1');

  await page.goto('file:///C:/Users/丞哥飞呀/cb-ration-new/index.html', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 1200));

  // 点击审核进度Tab
  await page.click('#tab-progress');
  await new Promise(r => setTimeout(r, 1000));

  // 截图整个页面（从hero到第一张卡片）
  const hero = await page.$('.hero');
  if (hero) await hero.screenshot({ path: 'C:/Users/丞哥飞呀/cb-ration-new/_hero.png' });

  // 截图第一张卡片
  const item = await page.$('#progressPanel .cb-item');
  if (item) await item.screenshot({ path: 'C:/Users/丞哥飞呀/cb-ration-new/_card2.png' });

  // 验证搜索框位置和排序chips大小
  const info = await page.evaluate(() => {
    const hs = document.getElementById('heroSearch');
    const hsp = document.getElementById('heroSearchPend');
    const sb = document.querySelector('#progressPanel .sort-bar');
    const btn = sb ? sb.querySelector('.sort-btn') : null;
    return {
      heroSearchDisplay: hs ? window.getComputedStyle(hs).display : 'NOT_FOUND',
      heroSearchPendDisplay: hsp ? window.getComputedStyle(hsp).display : 'NOT_FOUND',
      sortBtnFont: btn ? window.getComputedStyle(btn).fontSize : 'NO_BTN',
      sortBtnText: btn ? btn.textContent.trim() : '',
      heroSearchRect: hs ? hs.getBoundingClientRect() : null,
      firstCardTop: (() => { const c = document.querySelector('#progressPanel .cb-item'); return c ? Math.round(c.getBoundingClientRect().top) : null; })()
    };
  });

  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
