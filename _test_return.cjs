const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({headless:true, args:['--no-sandbox','--disable-setuid-sandbox']});
  const page = await browser.newPage();
  const errors=[];
  page.on('console', m=>{ if(m.type()==='error') errors.push(m.text()); });
  page.on('pageerror', e=> errors.push('PAGEERROR: '+e.message));
  await page.goto('file:///C:/Users/丞哥飞呀/cb-ration-new/go.html', {waitUntil:'networkidle0', timeout:20000});
  await new Promise(r=>setTimeout(r,2500));

  async function testFromTab(tabId, viewId, label){
    // 切到目标tab
    await page.click('#'+tabId);
    await new Promise(r=>setTimeout(r,1200));
    // 找第一个可点击卡片/行
    const clickable = await page.evaluate((viewId)=>{
      const v=document.getElementById(viewId);
      if(!v) return null;
      const item=v.querySelector('.cb-item')||v.querySelector('tr.clickable');
      if(!item) return null;
      return true;
    }, viewId);
    if(!clickable){ console.log(label+'：找不到卡片'); return; }
    // 点卡片打开详情
    await page.evaluate((viewId)=>{
      const v=document.getElementById(viewId);
      const item=v.querySelector('.cb-item')||v.querySelector('tr.clickable');
      item.click();
    }, viewId);
    await new Promise(r=>setTimeout(r,800));
    const maskShown = await page.evaluate(()=>document.getElementById('mask').classList.contains('show'));
    // 点返回(#mx)
    await page.evaluate(()=>document.getElementById('mx').click());
    await new Promise(r=>setTimeout(r,600));
    const result = await page.evaluate(()=>{
      const vp=document.getElementById('view-pend');
      const vpr=document.getElementById('view-progress');
      const vf=document.getElementById('view-fav');
      const pendActive=document.getElementById('tab-pend').classList.contains('active');
      const progActive=document.getElementById('tab-progress').classList.contains('active');
      const favActive=document.getElementById('tab-fav').classList.contains('active');
      return {
        maskHidden: !document.getElementById('mask').classList.contains('show'),
        viewPend: vp.style.display, viewProgress: vpr.style.display, viewFav: vf.style.display,
        pendActive, progActive, favActive
      };
    });
    console.log('['+label+'] mask打开='+maskShown+' | 返回后:','view-pend='+result.viewPend,'view-progress='+result.viewProgress,'view-fav='+result.viewFav,'tab高亮 pend='+result.pendActive,'prog='+result.progActive,'fav='+result.favActive);
  }

  console.log('=== 从「待发债」进入详情后返回 ===');
  await testFromTab('tab-pend','view-pend','待发债');
  console.log('=== 从「审核进度」进入详情后返回 ===');
  await testFromTab('tab-progress','view-progress','审核进度');
  console.log('=== 从「我的关注」进入详情后返回 ===');
  await testFromTab('tab-fav','view-fav','我的关注');

  if(errors.length) console.log('页面错误:', errors.slice(0,5));
  await browser.close();
})();
