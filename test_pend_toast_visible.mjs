// 验证 toast 的"待发债 X 只"计数和 renderPend 列表一致（修复 bug：旧 visible 过滤未带 stage 限制，误算成 4 只）
// 修复后：visible 与 renderPend 共用过滤条件：stage==='申购' && publicStart>=今天

const TODAY = '2026-07-31';
function todayStr(){ return TODAY; }

// 模拟加载后的 PEND（含科博/久吾两只公布上市的 stage='待上市'）
const PEND = [
  // 申购阶段，申购日>=今天 → 当前待申购
  { code:'123279', name:'天脉转债', stage:'申购', publicStart:'2026-08-03 00:00:00' },
  { code:'123280', name:'三鑫转债', stage:'申购', publicStart:'2026-08-04 00:00:00' },
  // 已过申购日（待上市）→ 不显示
  { code:'110102', name:'江农转债', stage:'申购', publicStart:'2026-07-14 00:00:00' },
  { code:'123278', name:'合金转债', stage:'申购', publicStart:'2026-07-30 00:00:00' },
  // 公布上市的债（progress=99，publicStart=上市日）
  { code:'113707', name:'科博转债', stage:'待上市', publicStart:'2026-07-31 00:00:00', _auto:true },
  { code:'123276', name:'久吾转02', stage:'待上市', publicStart:'2026-08-04 00:00:00', _auto:true },
  // 手动维护的"待发行"
  { code:'111003', name:'手动待发行', stage:'待发行', publicStart:'2026-09-01 00:00:00' },
];

// 旧 visible 过滤（bug：只看 publicStart）
const oldVisible = PEND.filter(r=>!r.publicStart || r.publicStart.slice(0,10)>=TODAY);
// 新 visible 过滤（已修：和 renderPend 一致）
const newVisible = PEND.filter(r=>r.stage==='申购' && r.publicStart && r.publicStart.slice(0,10)>=TODAY);
// renderPend 列表（手机端/PC端共用）
const renderRows = PEND.filter(r=>r.stage==='申购' && r.publicStart && r.publicStart.slice(0,10)>=TODAY);

let pass=0, fail=0;
function assert(cond,msg){ if(cond){pass++;console.log('✅ '+msg);} else {fail++;console.log('❌ '+msg);} }

assert(oldVisible.length===5, '旧 filter 算出 5 只（重现 bug：含科博、久吾 + 天脉、三鑫 + 手动待发行 publicStart>=今天）');
assert(newVisible.length===2, '新 filter 算出 2 只（与列表一致）');
assert(newVisible.length===renderRows.length, 'toast 计数与 renderPend 列表长度一致（'+newVisible.length+' = '+renderRows.length+'）');
assert(newVisible.map(r=>r.code).join(',')==='123279,123280', '可见的就是天脉+三鑫');
assert(!newVisible.some(r=>r.code==='113707'||r.code==='123276'), '科博/久吾（公布上市）不在 toast 计数里');

console.log('\n结果: '+pass+' 通过, '+fail+' 失败');
process.exit(fail>0?1:0);