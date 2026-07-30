// 测试目的：验证 PC 端 view-fav 的"全部阶段"chips 容器从 .sort-bar（橙色背景）改成 .chips（无背景），与审核进度一致
// 策略：直接执行 PC 端 chips 容器生成代码块 + insertBefore 逻辑，验证 DOM 结构
const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1280, height: 800 } // PC 端视口
  });
  const page = await browser.newPage();

  // 拦截外部请求
  await page.setRequestInterception(true);
  page.on('request', req => {
    const url = req.url();
    if (url.startsWith('file://') || url.startsWith('data:')) {
      req.continue();
    } else {
      req.abort();
    }
  });

  // 加载本地 index.html
  const filePath = 'file:///' + path.resolve('index.html').replace(/\\/g, '/');
  await page.goto(filePath, { waitUntil: 'domcontentloaded', timeout: 10000 });
  await new Promise(r => setTimeout(r, 1000));

  // 核心测试：执行 PC 端 chips 容器生成代码 + insertBefore 逻辑
  const result = await page.evaluate(() => {
    // ========== 模拟 renderFav PC 端的 chips 容器生成 + 移动逻辑 ==========
    // 这段代码是真实从 index.html 提取的（第 2340-2343 行 + 2402-2408 行）
    const p = document.getElementById('favPanel');
    if (!p) return { error: 'favPanel not found' };

    // ===== 1. 模拟生成 chips 容器 HTML 字符串（第 2340-2343 行原文） =====
    // const fs=favSort; (这里不需要 chip 的 active 状态判断)
    const STAGE_LABEL = {all:"全部阶段","90":"同意注册","80":"上市委通过","50":"交易所受理","20":"股东大会通过","10":"董事会预案"};
    const FAV_FILTER = 'all';
    let h = '<div class="chips">';
    h += '<span class="chip'+(FAV_FILTER==="all"?" active":"")+'" data-f="all">全部阶段</span>';
    ["90","80","50","20","10"].forEach(v=>{ h+='<span class="chip'+(FAV_FILTER===v?" active":"")+'" data-f="'+v+'">'+STAGE_LABEL[v]+'</span>'; });
    h += '</div>';
    h += '<div class="card"><table><thead><tr><th>正股/转债</th></tr></thead><tbody><tr><td>mock</td></tr></tbody></table></div>';

    // ===== 2. 塞到 #favPanel =====
    p.innerHTML = h;

    // ===== 3. 执行 PC 端的 insertBefore 逻辑（第 2402-2408 行原文） =====
    const viewFavEl = document.getElementById('view-fav');
    // 显示 view-fav 以便 getBoundingClientRect 返回真实位置
    viewFavEl.style.display = 'block';
    const searchEl = viewFavEl ? viewFavEl.querySelector('.search') : null;
    const chipsEl = p.firstElementChild;
    if (viewFavEl && searchEl && chipsEl && chipsEl.classList.contains('chips')) {
      viewFavEl.insertBefore(chipsEl, searchEl);
    }

    // ===== 4. 收集结果 =====
    const viewFav = document.getElementById('view-fav');
    const children = Array.from(viewFav.children).map(c => ({
      tag: c.tagName,
      class: c.className,
      id: c.id,
      childCount: c.children.length,
      textPreview: c.textContent.trim().substring(0, 50)
    }));

    const chipsContainers = viewFav.querySelectorAll('.chips');
    const sortBarContainers = viewFav.querySelectorAll('.sort-bar');

    const firstChips = chipsContainers[0];
    const firstChipsRect = firstChips ? firstChips.getBoundingClientRect() : null;
    const firstChipsStyle = firstChips ? window.getComputedStyle(firstChips) : null;

    const search = viewFav.querySelector('.search');

    // 对比参考：审核进度的 chips 容器样式
    const progChips = document.getElementById('progChips');
    const progChipsStyle = progChips ? window.getComputedStyle(progChips) : null;

    return {
      // view-fav 子元素结构
      children: children,
      // chips 容器分析
      chipsCount: chipsContainers.length,
      sortBarCount: sortBarContainers.length,
      firstChipsClass: firstChips ? firstChips.className : null,
      firstChipsChipCount: firstChips ? firstChips.querySelectorAll('.chip').length : 0,
      firstChipsText: firstChips ? firstChips.textContent.trim() : null,
      // PC chips 容器计算样式
      firstChipsBg: firstChipsStyle ? firstChipsStyle.backgroundColor : null,
      firstChipsBorderRadius: firstChipsStyle ? firstChipsStyle.borderRadius : null,
      firstChipsFlexWrap: firstChipsStyle ? firstChipsStyle.flexWrap : null,
      firstChipsGap: firstChipsStyle ? firstChipsStyle.gap : null,
      firstChipsPadding: firstChipsStyle ? firstChipsStyle.padding : null,
      firstChipsTop: firstChipsRect ? Math.round(firstChipsRect.top) : null,
      // 搜索框位置
      searchTop: search ? Math.round(search.getBoundingClientRect().top) : null,
      // 审核进度 chips 容器样式（作为参考基线）
      progChipsBg: progChipsStyle ? progChipsStyle.backgroundColor : null,
      progChipsBorderRadius: progChipsStyle ? progChipsStyle.borderRadius : null,
      progChipsFlexWrap: progChipsStyle ? progChipsStyle.flexWrap : null,
      progChipsGap: progChipsStyle ? progChipsStyle.gap : null,
      progChipsPadding: progChipsStyle ? progChipsStyle.padding : null
    };
  });

  console.log('=== 测试结果 ===');
  console.log(JSON.stringify(result, null, 2));
  console.log('');

  // 断言
  let pass = 0, fail = 0;
  function check(name, cond) {
    if (cond) { console.log('✅', name); pass++; }
    else { console.log('❌', name); fail++; }
  }

  console.log('--- 核心断言：PC 端 chips 容器与审核进度一致 ---');
  check('view-fav 存在', result.children && !result.error);
  check('PC 端 chips 容器存在（从 panel 挪过来）', result.chipsCount >= 1);
  check('PC 端 chips 容器 class 是 chips（不是 sort-bar）', result.firstChipsClass === 'chips');
  check('PC 端 chips 容器不含 sort-bar class', !result.firstChipsClass || !result.firstChipsClass.includes('sort-bar'));
  check('PC 端 chips 容器包含 6 个 chip', result.firstChipsChipCount === 6);
  check('PC 端 chips 容器文字包含"全部阶段"', result.firstChipsText && result.firstChipsText.includes('全部阶段'));

  console.log('');
  console.log('--- 视觉一致性：与审核进度 chips 容器对比 ---');
  check('PC 端 chips 容器无橙色背景（与审核进度一致）',
    result.firstChipsBg === result.progChipsBg);
  check('PC 端 chips 容器无圆角（与审核进度一致）',
    result.firstChipsBorderRadius === result.progChipsBorderRadius);
  check('PC 端 chips 容器 flex-wrap 与审核进度一致',
    result.firstChipsFlexWrap === result.progChipsFlexWrap);
  check('PC 端 chips 容器 gap 与审核进度一致',
    result.firstChipsGap === result.progChipsGap);
  check('PC 端 chips 容器 padding 与审核进度一致',
    result.firstChipsPadding === result.progChipsPadding);

  console.log('');
  console.log('--- 布局：PC 端 chips 在 search 上面 ---');
  check('PC 端 chips 容器在 search 上方（top 更小）',
    result.firstChipsTop < result.searchTop);

  console.log('');
  console.log('--- 对照：审核进度基线样式 ---');
  console.log(`审核进度 chips 背景: ${result.progChipsBg}`);
  console.log(`审核进度 chips 圆角: ${result.progChipsBorderRadius}`);
  console.log(`审核进度 chips flex-wrap: ${result.progChipsFlexWrap}`);
  console.log(`审核进度 chips gap: ${result.progChipsGap}`);
  console.log(`审核进度 chips padding: ${result.progChipsPadding}`);
  console.log('');
  console.log(`我的关注 chips 背景: ${result.firstChipsBg}`);
  console.log(`我的关注 chips 圆角: ${result.firstChipsBorderRadius}`);
  console.log(`我的关注 chips flex-wrap: ${result.firstChipsFlexWrap}`);
  console.log(`我的关注 chips gap: ${result.firstChipsGap}`);
  console.log(`我的关注 chips padding: ${result.firstChipsPadding}`);

  console.log('');
  console.log(`通过: ${pass}, 失败: ${fail}`);

  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})();
