// 待发债自动同步：把集思录"已公告申购"(progress=90 且 progress_nm 含"申购")的标的
// 并入 SNAPSHOT_PEND，与手动维护的待发清单合并。
//
// 设计要点：
// 1. 自动债统一标 _auto:true，每轮由集思录重算；下一轮合并时丢弃上一轮的 _auto 债，
//    避免过期申购债在 PEND 里无限堆积（renderPend 虽会按 publicStart 过滤不显示，
//    但数组本身不应越积越大）。
// 2. 手动债（_auto !== true）始终保留，飞哥仍可手工往 PEND 里加"待发行"等阶段的标的。
// 3. 同 code 时自动债覆盖手动债（自动字段更新鲜，且含 _c 计算值）。
// 4. publicStart 用集思录 progress_dt（申购日）+ " 00:00:00"，与手动格式一致，
//    renderPend 据此过滤"已过申购日"的债。
//
// 纯函数，无副作用，便于单测。

export function syncApplyBonds(manualPend, filtered) {
  // 1) 当前集思录 progress=90 且含"申购" 的标的
  const applyList = (filtered || []).filter(
    o => o && o.progress === '90' && o.progress_nm && o.progress_nm.indexOf('申购') >= 0
  );

  // 2) 保留手动债（_auto 不为 true）
  const manual = (manualPend || []).filter(b => b && b._auto !== true);

  // 3) 自动债映射（标 _auto，字段对齐 PEND 格式）
  const autoMap = {};
  applyList.forEach(o => {
    autoMap[o.code] = {
      _auto: true,
      code: o.code,
      name: o.name,
      stockCode: o.stockCode,
      stockName: o.stockName,
      convertPrice: o.convertPrice,
      perPre: o.perPre,
      scale: o.scale,
      publicStart: o.progress_dt ? o.progress_dt + ' 00:00:00' : '',
      listDate: '',
      stage: '申购',
      apply10: o.apply10,
      rating_cd: o.rating_cd,
      _c: o._c || {}
    };
  });

  // 4) 合并：手动打底，自动覆盖/追加
  const result = manual.slice();
  Object.values(autoMap).forEach(a => {
    const idx = result.findIndex(b => b.code === a.code);
    if (idx >= 0) result[idx] = a; // 同 code 自动覆盖手动
    else result.push(a);
  });

  return result;
}
