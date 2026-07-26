const puppeteer=require('puppeteer');
const fs=require('fs');
const html=fs.readFileSync('C:/Users/丞哥飞呀/cb-ration-new/index.html','utf8');
(async()=>{
  const b=await puppeteer.launch({headless:true,executablePath:(await puppeteer.executablePath()).replace('app.asar','')||undefined,args:['--no-sandbox']});
  const p=await b.newPage();
  await p.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1');
  await p.setViewport({width:390,height:844});
  await p.setContent(html,{waitUntil:'networkidle0'});
  await new Promise(r=>setTimeout(r,2000));
  
  // 截图：待发债Tab
  await p.click('#tab-pend');
  await new Promise(r=>setTimeout(r,1000));
  await p.screenshot({path:'C:/Users/丞哥飞呀/cb-ration-new/_pend.png',fullPage:false});
  
  // 截图：审核进度Tab
  await p.click('#tab-progress');
  await new Promise(r=>setTimeout(r,1000));
  await p.screenshot({path:'C:/Users/丞哥飞呀/cb-ration-new/_prog.png',fullPage:false});
  
  // 截图：关注Tab
  await p.click('#tab-fav');
  await new Promise(r=>setTimeout(r,1000));
  await p.screenshot({path:'C:/Users/丞哥飞呀/cb-ration-new/_fav.png',fullPage:false});

  // 量待发债第一张卡片的grid列数
  const pendGrid=await p.evaluate(()=>{
    const el=document.querySelector('#panel .cb-stats');
    if(!el)return 'NO_STATS';
    const s=getComputedStyle(el);
    return {gridTemplateColumns:s.gridTemplateColumns,childCount:el.children.length};
  });
  console.log('待发债grid:',pendGrid);

  // 量审核进度第一张卡片
  const progGrid=await p.evaluate(()=>{
    const el=document.querySelector('#progressPanel .cb-stats');
    if(!el)return 'NO_STATS';
    const s=getComputedStyle(el);
    return {gridTemplateColumns:s.gridTemplateColumns,childCount:el.children.length};
  });
  console.log('审核进度grid:',progGrid);

  // 检查域名文字是否已删除
  const subText=await p.evaluate(()=>{const el=document.querySelector('.sub');return el?el.textContent.trim():'NOT_FOUND';});
  console.log('.sub文本:',subText);

  // 检查搜索框max-width
  const searchMaxW=await p.evaluate(()=>{const el=document.querySelector('.search input');return el?getComputedStyle(el).maxWidth:'NOT_FOUND';});
  console.log('搜索框max-width:',searchMaxW);

  await b.close();
  console.log('DONE - screenshots saved');
})();
