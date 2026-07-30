import assert from 'assert';
import { syncApplyBonds } from './pend_sync.mjs';

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ✅ ' + name); pass++; }
  catch (e) { console.log('  ❌ ' + name + ' → ' + e.message); fail++; }
}

// ===== Mock 数据 =====
const manualPend = [
  { code: '118074', name: '特宝转债', stockCode: '688278', stockName: '特宝生物', stage: '申购', publicStart: '2026-07-28 00:00:00', scale: 15.33, _c: { estFloat: 6.47 } },
  { code: '110099', name: '某待发债', stockCode: '600999', stockName: '某待发股', stage: '待发行', publicStart: '', scale: 5 },
  { code: '123999', name: '手动测试债', stockCode: '300999', stockName: '手动股', stage: '申购', publicStart: '2026-09-01 00:00:00', scale: 3 }
];
const filtered = [
  { code: '123279', name: '天脉转债', stockCode: '301626', stockName: '苏州天脉', progress: '90', progress_nm: '2026-08-03申购 申购代码371626', progress_dt: '2026-08-03', scale: 7.86, convertPrice: 267.33, perPre: 6.7946, apply10: 148, rating_cd: 'AA', _c: { cv: 79.04, needShares: 148, needMoney: 31272.4, baiyuan: 3.21, price: 211.3, estFloat: 3.72 } },
  { code: '123278', name: '合金转债', stockCode: '300697', stockName: '电工合金', progress: '90', progress_nm: '2026-07-30申购 申购代码370697', progress_dt: '2026-07-30', scale: 5.45, convertPrice: 13.98, perPre: 1.2597, apply10: 794, rating_cd: 'AA-', _c: { cv: 91.77, needShares: 794, needMoney: 10187.02, baiyuan: 9.81, price: 12.83, estFloat: 2.11 } },
  { code: '113709', name: '振26转债', stockCode: '603067', stockName: '振华股份', progress: '90', progress_nm: '2026-07-30申购 申购代码754067', progress_dt: '2026-07-30', scale: 8.78, convertPrice: 40.33, perPre: 1.162, apply10: 861, rating_cd: 'AA', _c: { cv: 70.19, needShares: 861, needMoney: 24374.91, baiyuan: 4.10, price: 28.31, estFloat: 5.07 } },
  { code: '123777', name: '同意注册债', stockCode: '301777', stockName: '某股', progress: '90', progress_nm: '同意注册', progress_dt: '', scale: 4, _c: { cv: 95 } },
  { code: '123666', name: '董事会预案债', stockCode: '301666', stockName: '某股2', progress: '10', progress_nm: '董事会预案', progress_dt: '', scale: 6, _c: { cv: 98 } }
];

console.log('=== 测试1: 基本合并 ===');
check('合计 6 只 (手动3 + 自动3)', () => {
  const r = syncApplyBonds(manualPend, filtered);
  assert.strictEqual(r.length, 6);
});
check('不含"同意注册"债', () => {
  const r = syncApplyBonds(manualPend, filtered);
  assert.ok(!r.some(b => b.code === '123777'));
});
check('不含"董事会预案"债', () => {
  const r = syncApplyBonds(manualPend, filtered);
  assert.ok(!r.some(b => b.code === '123666'));
});
check('自动债标 _auto=true', () => {
  const r = syncApplyBonds(manualPend, filtered);
  const tianmai = r.find(b => b.code === '123279');
  assert.strictEqual(tianmai._auto, true);
  assert.strictEqual(tianmai.stage, '申购');
});
check('手动债保留且 _auto 不为 true', () => {
  const r = syncApplyBonds(manualPend, filtered);
  const tebao = r.find(b => b.code === '118074');
  assert.ok(tebao && tebao._auto !== true);
  const daifa = r.find(b => b.code === '110099');
  assert.ok(daifa && daifa._auto !== true && daifa.stage === '待发行');
});
check('publicStart 由 progress_dt 生成 (合金)', () => {
  const r = syncApplyBonds(manualPend, filtered);
  const hejin = r.find(b => b.code === '123278');
  assert.strictEqual(hejin.publicStart, '2026-07-30 00:00:00');
});
check('自动债字段完整映射 (天脉)', () => {
  const r = syncApplyBonds(manualPend, filtered);
  const t = r.find(b => b.code === '123279');
  assert.strictEqual(t.stockCode, '301626');
  assert.strictEqual(t.stockName, '苏州天脉');
  assert.strictEqual(t.convertPrice, 267.33);
  assert.strictEqual(t.perPre, 6.7946);
  assert.strictEqual(t.scale, 7.86);
  assert.strictEqual(t.apply10, 148);
  assert.strictEqual(t.rating_cd, 'AA');
  assert.strictEqual(t.listDate, '');
  assert.ok(t._c && t._c.estFloat === 3.72);
});
check('同 code 自动覆盖手动 (手动测试债123999被自动版覆盖)', () => {
  // 把 123999 也放 progress=90 申购，验证被覆盖为 _auto 版
  const f2 = filtered.concat([{ code: '123999', name: '自动覆盖债', stockCode: '300999', stockName: '手动股', progress: '90', progress_nm: '2026-10-01申购 申购代码370999', progress_dt: '2026-10-01', scale: 3, _c: {} }]);
  const r = syncApplyBonds(manualPend, f2);
  const x = r.find(b => b.code === '123999');
  assert.strictEqual(x._auto, true);
  assert.strictEqual(x.publicStart, '2026-10-01 00:00:00');
  assert.strictEqual(x.name, '自动覆盖债');
});

console.log('\n=== 测试2: 不累积（下轮过期自动债自动消失）===');
check('第二轮过滤掉上一轮的 _auto 过期债', () => {
  const round1 = syncApplyBonds(manualPend, filtered);
  // 第二轮：合金/振26 已不在集思录90申购列表（假设变上市/99），只剩天脉
  const filtered2 = filtered.filter(o => o.code === '123279');
  const round2 = syncApplyBonds(round1, filtered2);
  assert.ok(!round2.some(b => b.code === '123278'), '合金应消失');
  assert.ok(!round2.some(b => b.code === '113709'), '振26应消失');
  assert.ok(round2.some(b => b.code === '123279'), '天脉保留');
  // 手动债全部保留
  assert.ok(round2.some(b => b.code === '118074'));
  assert.ok(round2.some(b => b.code === '110099'));
  assert.ok(round2.some(b => b.code === '123999'));
  assert.strictEqual(round2.length, 4); // 3手动(118074/110099/123999) + 1天脉_auto
});

console.log('\n=== 结果 ===');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
