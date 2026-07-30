// 验证 renderPend 的"只留当前待申购"过滤逻辑
// 过滤表达式：r => r.stage === '申购' && r.publicStart && r.publicStart.slice(0,10) >= todayStr()

const TODAY = '2026-07-31'; // 固定为当前业务日期，避免系统时间抖动影响断言
function todayStr(){ return TODAY; }

const filterFn = r => r.stage === '申购' && r.publicStart && r.publicStart.slice(0,10) >= todayStr();

// 模拟 PEND 数据（取自真实场景）
const PEND = [
  { code:'111001', name:'测试转债A', stage:'申购', publicStart:'2026-08-03 00:00:00' },          // 1. 当前待申购 → 保留
  { code:'111002', name:'测试转债B', stage:'申购', publicStart:'2026-07-28 00:00:00' },          // 2. 已过申购日 → 移除
  { code:'113707', name:'科博转债', stage:'待上市', publicStart:'2026-07-31 00:00:00', _auto:true }, // 3. 公布上市(已上市) → 移除
  { code:'123276', name:'久吾转02', stage:'待上市', publicStart:'2026-08-04 00:00:00', _auto:true }, // 4. 公布上市 → 移除
  { code:'111003', name:'手动待发行', stage:'待发行', publicStart:'2026-09-01 00:00:00' },        // 5. 手动待发行 → 移除
  { code:'111004', name:'无申购日债', stage:'申购', publicStart:'' },                            // 6. 申购但无申购日 → 移除
];

let pass=0, fail=0;
function assert(cond,msg){ if(cond){pass++;console.log('✅ '+msg);} else {fail++;console.log('❌ '+msg);} }

const rows = PEND.filter(filterFn);
const keptCodes = rows.map(r=>r.code);

assert(rows.length===1, '只保留 1 只（实际 '+rows.length+' 只）');
assert(keptCodes.includes('111001'), '当前待申购债(111001)被保留');
assert(!keptCodes.includes('111002'), '已过申购日的(111002)被移除');
assert(!keptCodes.includes('113707'), '公布上市的科博转债(113707)被移除');
assert(!keptCodes.includes('123276'), '公布上市的久吾转02(123276)被移除');
assert(!keptCodes.includes('111003'), '手动待发行(111003)被移除');
assert(!keptCodes.includes('111004'), '无申购日的(111004)被移除');

console.log('\n结果: '+pass+' 通过, '+fail+' 失败');
process.exit(fail>0?1:0);
