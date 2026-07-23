import fs from 'fs';
const HTML='./index.html';
const API='https://www.jisilu.cn/webapi/cb/pre/';

function todayStr(){
  const d=new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}

function computeC(o){
  if(o.price==null||!o.convertPrice) return null;
  const cv=o.price/o.convertPrice*100;
  const shares=(o.apply10&&o.apply10>0)?o.apply10:(o.perPre&&o.perPre>0?Math.ceil(1000/o.perPre):null);
  const effPerPre=(o.perPre&&o.perPre>0)?o.perPre:(shares?1000/shares:null);
  let needShares=null,needMoney=null,baiyuan=null;
  if(shares&&o.price){
    needShares=shares; needMoney=shares*o.price;
    if(effPerPre) baiyuan=effPerPre*100/o.price;
  }
  return {cv,needShares,needMoney,baiyuan,price:o.price};
}

(async()=>{
  const r=await fetch(API,{headers:{'User-Agent':'Mozilla/5.0','Referer':'https://www.jisilu.cn/web/data/cb/'}});
  const d=await r.json();
  if(!d.data||!d.data.length){console.error('API无数据');process.exit(1);}
  const today=todayStr();
  const all=d.data.map(x=>({
    stockCode:x.stock_id, stockName:x.stock_nm, code:x.bond_id||'', name:x.bond_nm||'',
    progress:String(x.progress),
    progress_nm:(x.progress_nm||'').replace(/<br>/g,' ').replace(/\s+/g,' ').trim(),
    scale:x.amount, convertPrice:x.convert_price, price:x.price,
    perPre:x.ration!=null?parseFloat(x.ration):null,
    apply10:x.apply10!=null?parseInt(x.apply10):null,
    ration_rt:x.ration_rt, rating_cd:x.rating_cd,
    progress_full:(x.progress_full||'').trim(),
    accept_date:x.accept_date, progress_dt:x.progress_dt,
    apply_date:x.apply_date||null, record_dt:x.record_dt||null,
    apply_cd:x.apply_cd||null, ration_cd:x.ration_cd||null
  }));
  all.forEach(o=>{o._c=computeC(o);});
  // PEND: progress=90 + apply_date>=today
  // PROGRESS: all except 99 and 90-with-passed-apply_date
  const pend=[], progress=[];
  all.forEach(o=>{
    if(o.progress==='99') return;
    if(o.progress==='90'){
      if(o.apply_date && o.apply_date>=today){
        pend.push({code:o.code,name:o.name,stockCode:o.stockCode,stockName:o.stockName,
          convertPrice:o.convertPrice,perPre:o.perPre,scale:o.scale,
          publicStart:o.apply_date+' 00:00:00',listDate:'',stage:'申购',_c:o._c,
          apply10:o.apply10,rating_cd:o.rating_cd});
      } else if(!o.apply_date){
        progress.push(o); // 同意注册但未排期
      }
      // apply_date < today → 已过申购日，跳过
    } else {
      progress.push(o);
    }
  });
  let html=fs.readFileSync(HTML,'utf8');
  const pendLit='[\n'+pend.map(o=>JSON.stringify(o)).join(',\n')+'\n]';
  const rePend=/const SNAPSHOT_PEND=\[[\s\S]*?\];/;
  if(!rePend.test(html)){console.error('HTML未找到SNAPSHOT_PEND');process.exit(1);}
  html=html.replace(rePend,'const SNAPSHOT_PEND='+pendLit+';');
  const progLit='[\n'+progress.map(o=>JSON.stringify(o)).join(',\n')+'\n]';
  const reProg=/const SNAPSHOT_PROGRESS=\[[\s\S]*?\];/;
  if(!reProg.test(html)){console.error('HTML未找到SNAPSHOT_PROGRESS');process.exit(1);}
  html=html.replace(reProg,'const SNAPSHOT_PROGRESS='+progLit+';');
  fs.writeFileSync(HTML,html);
  console.log('OK: PEND='+pend.length+'条, PROGRESS='+progress.length+'条');
  console.log('PEND:',pend.map(o=>o.name).join(', ')||'(空)');
  const cnt={}; progress.forEach(o=>cnt[o.progress]=(cnt[o.progress]||0)+1);
  console.log('PROGRESS分布:',JSON.stringify(cnt));
})().catch(e=>{console.error('失败:',e.message);process.exit(1);});
