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
  const item = await page.$('#progressPanel .cb-item');
  if (item) await item.screenshot({ path: 'C:/Users/丞哥飞呀/cb-ration-new/_fixed.png' });
  console.log('DONE');
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
