// 测试 syncApplyBonds 的"上市债"同步分支
import { syncApplyBonds } from './pend_sync.mjs';

let pass = 0, fail = 0;
function assert(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}

// 模拟集思录 filtered（已剔除 progress=99） + listedArr（含上市债）
const filtered = [
  { code: '123279', name: '天脉转债', stockCode: '301626', stockName: '苏州天脉', progress: '90', progress_nm: '2026-08-03申购 申购代码371626', progress_dt: '2026-08-03', scale: 7.86, convertPrice: 100, price: 101, _c: { cv: 79 } },
  { code: '113709', name: '振26转债', stockCode: '603067', stockName: '振华股份', progress: '90', progress_nm: '2026-07-30申购 申购代码754067', progress_dt: '2026-07-30', scale: 8.78, convertPrice: 100, price: 100, _c: { cv: 70 } },
];
const listedArr = [
  { code: '123276', name: '久吾转02', stockCode: '300631', stockName: '久吾高科', progress: '99', progress_nm: '2026-08-04上市', progress_dt: '2026-08-04', scale: 4.0, convertPrice: 100, price: 105, _c: { cv: 105 } },
  { code: '113707', name: '科博转债', stockCode: '603786', stockName: '科博达', progress: '99', progress_nm: '2026-07-31上市', progress_dt: '2026-07-31', scale: 15.0, convertPrice: 100, price: 100, _c: { cv: 100 } },
  // 不含"上市"的 progress=99 债（如"已上市"状态）不应被并入
  { code: '110000', name: '示例转债', stockCode: '600000', stockName: '示例', progress: '99', progress_nm: '已上市', progress_dt: '2026-07-01', scale: 1, convertPrice: 100, price: 100, _c: {} },
];

// 手动维护的债（_auto !== true）
const manual = [
  { _auto: false, code: '123280', name: '三鑫转债', stockCode: '300453', stockName: '三鑫医疗', scale: 5.3, publicStart: '2026-08-04 00:00:00', stage: '申购' },
];

console.log('=== 测试用例1：上市债应并入待发债 ===');
const r1 = syncApplyBonds(manual, filtered, listedArr);
const byCode = {};
r1.forEach(b => byCode[b.code] = b);

assert('待发债合计 = 5 只（1手动 + 2申购 + 2上市）', r1.length === 5);
assert('久吾转02 已并入', !!byCode['123276']);
assert('科博转债 已并入', !!byCode['113707']);
assert('久吾转02 stage=待上市', byCode['123276'] && byCode['123276'].stage === '待上市');
assert('科博转债 stage=待上市', byCode['113707'] && byCode['113707'].stage === '待上市');
assert('久吾转02 publicStart=上市日 2026-08-04', byCode['123276'] && byCode['123276'].publicStart === '2026-08-04 00:00:00');
assert('久吾转02 listDate=上市日 2026-08-04', byCode['123276'] && byCode['123276'].listDate === '2026-08-04 00:00:00');
assert('久吾转02 标 _auto=true', byCode['123276'] && byCode['123276']._auto === true);
assert('"已上市"状态债(110000) 未并入（不含"上市"二字）', !byCode['110000']);
assert('天脉转债 仍为申购', byCode['123279'] && byCode['123279'].stage === '申购');
assert('手动三鑫转债 保留', !!byCode['123280'] && byCode['123280']._auto !== true);

console.log('=== 测试用例2：下一轮合并时旧上市债自动消失（不累积）===');
// 模拟下一轮：久吾转02 已真正上市，集思录不再返回 progress=99 含"上市"
const listedArr2 = [
  { code: '113707', name: '科博转债', stockCode: '603786', stockName: '科博达', progress: '99', progress_nm: '2026-07-31上市', progress_dt: '2026-07-31', scale: 15.0, convertPrice: 100, price: 100, _c: { cv: 100 } },
];
const r2 = syncApplyBonds(manual, filtered, listedArr2);
const byCode2 = {};
r2.forEach(b => byCode2[b.code] = b);
assert('下一轮久吾转02 已消失（集思录无该上市债）', !byCode2['123276']);
assert('科博转债 仍在', !!byCode2['113707']);
assert('待发债合计 = 4 只', r2.length === 4);

console.log('\n结果: 通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail > 0 ? 1 : 0);
