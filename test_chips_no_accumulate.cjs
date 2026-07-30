// 直接执行 PC 端 insertBefore 逻辑（line 2402-2408），模拟 5 次 renderFav
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
  page.on('pageerror', e => console.log('[pageerror]', e.message));

  const filePath = 'file:///' + path.resolve('index.html').replace(/\\/g, '/');
  await page.goto(filePath, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await new Promise(r => setTimeout(r, 1500));

  // 直接执行 PC 端 chips 容器生成 + insertBefore 逻辑
  const result = await page.evaluate(() => {
    document.getElementById('view-fav').style.display = 'block';

    const STAGE_LABEL = {all:"全部阶段","90":"同意注册","80":"上市委通过","50":"交易所受理","20":"股东大会通过","10":"董事会预案"};

    function simulateRenderFavCall() {
      // 模拟 renderFav 内部 PC 端行为：
      // 1. favPanel.innerHTML = '<div class="chips">...</div><div class="card"><table>...'
      // 2. 然后把 p.firstElementChild（chips）挪到 view-fav 内 search 之前
      const p = document.getElementById('favPanel');
      p.innerHTML = '<div class="chips"><span class="chip active" data-f="all">全部阶段</span><span class="chip" data-f="90">同意注册</span><span class="chip" data-f="80">上市委通过</span><span class="chip" data-f="50">交易所受理</span><span class="chip" data-f="20">股东大会通过</span><span class="chip" data-f="10">董事会预案</span></div><div class="card"><table><tbody><tr><td>测试行</td></tr></tbody></table></div>';

      // ===== 修复后逻辑（line 2402-2408）=====
      const viewFavEl = document.getElementById('view-fav');
      const searchEl = viewFavEl.querySelector('.search');
      const chipsEl = p.firstElementChild;
      if (viewFavEl && searchEl && chipsEl && chipsEl.classList.contains('chips')) {
        // 1) 清掉 view-fav 内所有残留的 .chips
        viewFavEl.querySelectorAll(':scope > .chips').forEach(el => el.remove());
        // 2) 移动新 chips 到 view-fav 在 search 之前
        viewFavEl.insertBefore(chipsEl, searchEl);
      }
    }

    // 调用 5 次，模拟 5 次切换 tab
    const counts = [];
    for (let i = 0; i < 5; i++) {
      simulateRenderFavCall();
      const viewFav = document.getElementById('view-fav');
      const directChips = Array.from(viewFav.children).filter(c => c.classList.contains('chips')).length;
      const allChips = viewFav.querySelectorAll('.chips').length;
      const childrenClasses = Array.from(viewFav.children).map(c => c.className || c.id);
      const chipText = viewFav.querySelector('.chips')?.textContent.replace(/\s+/g,'').slice(0, 30) || '';
      counts.push({ i: i+1, directChips, allChips, childrenClasses, chipText });
    }
    return counts;
  });

  console.log('=== 修复后：5 次 renderFav 后 view-fav 内部结构 ===');
  for (const c of result) {
    console.log(`第${c.i}次: 直接子元素chips=${c.directChips}, 全部chips=${c.allChips}, 子元素=[${c.childrenClasses.join(' | ')}], chip文字="${c.chipText}"`);
  }

  const last = result[result.length - 1];
  if (last.directChips === 1 && last.allChips === 1) {
    console.log('\n✅ 测试通过：每次 renderFav 后 view-fav 内只有 1 个 .chips 容器，无累积');
  } else {
    console.log(`\n❌ 测试失败：第5次后 directChips=${last.directChips}, allChips=${last.allChips}`);
  }

  await browser.close();
})();
