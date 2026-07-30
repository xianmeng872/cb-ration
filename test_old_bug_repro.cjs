// 对比测试：未修复时（不清理 view-fav 内残留 chips）会累积
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

  const result = await page.evaluate(() => {
    document.getElementById('view-fav').style.display = 'block';

    function simulateOldLogic() {
      // ===== 旧逻辑（没清理残留）=====
      const p = document.getElementById('favPanel');
      p.innerHTML = '<div class="chips"><span class="chip active">全部阶段</span></div><div class="card">data</div>';

      const viewFavEl = document.getElementById('view-fav');
      const searchEl = viewFavEl.querySelector('.search');
      const chipsEl = p.firstElementChild;
      if (viewFavEl && searchEl && chipsEl && chipsEl.classList.contains('chips')) {
        // 旧逻辑：只 insertBefore，不清残留
        viewFavEl.insertBefore(chipsEl, searchEl);
      }
    }

    const counts = [];
    for (let i = 0; i < 5; i++) {
      simulateOldLogic();
      const viewFav = document.getElementById('view-fav');
      const directChips = Array.from(viewFav.children).filter(c => c.classList.contains('chips')).length;
      counts.push({ i: i+1, directChips });
    }
    return counts;
  });

  console.log('=== 模拟旧逻辑（未修复）===');
  for (const c of result) {
    console.log(`第${c.i}次: 直接子元素chips=${c.directChips}`);
  }
  console.log('→ 模拟了飞哥截图中的"3 排"现象！');

  await browser.close();
})();
