// 验证 doSort 在 _kind="progress" 注入后，百元含权排序时把 progress=10/20 整体排到后面
// 直接复制 index.html 第 988-1022 行的 doSort 逻辑（避免 DOM 依赖）
const PROG_PRIORITY={90:5,80:4,50:3,20:2,10:1};
function getVal(r,f){
  if(f==="baiyuan"){
    if(r._c && r._c.baiyuan!=null) return r._c.baiyuan;
    if(r.perPre && r.price) return r.perPre*100/r.price;
    return -999;
  }
  return r[f];
}
function isEarlyStage(r){
  if(r._kind!=="progress") return false;
  const p=Number(r.progress)||0;
  return p===10 || p===20;
}
function doSort(rows,sort){
  if(!sort.field) return rows;
  const isBaiyuan=sort.field==="baiyuan";
  return rows.slice().sort((a,b)=>{
    if(isBaiyuan){
      const ea=isEarlyStage(a), eb=isEarlyStage(b);
      if(ea!==eb) return ea ? 1 : -1;
    }
    let va=getVal(a,sort.field), vb=getVal(b,sort.field);
    let cmp=0;
    if(typeof va==="string"&&typeof vb==="string"){cmp=va.localeCompare(vb);}
    else if(typeof va==="number"&&typeof vb==="number"){cmp=va-vb;}
    if(cmp!==0) return sort.dir*cmp;
    const pa2=Number(a.progress)||0, pb2=Number(b.progress)||0;
    if(pa2!==pb2) return sort.dir*(pb2-pa2);
    return 0;
  });
}

// Mock 数据：3 组标的（早期10/20、中期50/80、晚期90/已上市）
const rows=[
  // 早期 high 百元含权（不修 bug 会被排前面）
  {_kind:"progress",code:"X1",name:"早期1",progress:"20",price:10,_c:{baiyuan:50}},
  {_kind:"progress",code:"X2",name:"早期2",progress:"10",price:20,_c:{baiyuan:40}},
  // 中期
  {_kind:"progress",code:"M1",name:"中期1",progress:"80",price:30,_c:{baiyuan:30}},
  {_kind:"progress",code:"M2",name:"中期2",progress:"50",price:40,_c:{baiyuan:20}},
  // 晚期
  {_kind:"progress",code:"L1",name:"晚期1",progress:"90",price:50,_c:{baiyuan:10}},
];

let pass=0, fail=0;
function assert(cond, name){
  if(cond){console.log('  ✓ '+name);pass++;}
  else{console.log('  ✗ '+name);fail++;}
}

// 测试1：百元含权降序时，10/20 整体后置，50/80/90 按值降序在前
console.log('--- 百元含权降序 ---');
const r1=doSort(rows,{field:"baiyuan",dir:-1});
console.log('  顺序: '+r1.map(r=>r.name).join(' → '));
// 期望：M1(30) → M2(20) → L1(10) → 早期1(50) → 早期2(40)
assert(r1[0].name==='中期1', '第一是中期1（baiyuan=30）');
assert(r1[1].name==='中期2', '第二是中期2（baiyuan=20）');
assert(r1[2].name==='晚期1', '第三是晚期1（baiyuan=10）');
assert(r1[3].name==='早期1', '第四是早期1（虽然 baiyuan=50，但 progress=20 后置）');
assert(r1[4].name==='早期2', '第五是早期2（baiyuan=40, progress=10 后置）');

// 测试2：百元含权升序时，10/20 仍然整体后置（硬分组无视 dir）
console.log('--- 百元含权升序 ---');
const r2=doSort(rows,{field:"baiyuan",dir:1});
console.log('  顺序: '+r2.map(r=>r.name).join(' → '));
// 期望：L1(10) → M2(20) → M1(30) → 早期2(40) → 早期1(50)
assert(r2[3].name==='早期2', '升序时早期2 仍在 50/80/90 之后');
assert(r2[4].name==='早期1', '升序时早期1 仍在末尾');

// 测试3：非百元含权排序时，不触发硬分组（按值正常排）
console.log('--- progress 升序（不触发硬分组）---');
const r3=doSort(rows,{field:"progress",dir:1});
console.log('  顺序: '+r3.map(r=>r.name+' (progress='+r3[0].progress+')').join(' → '));
// 期望：按 progress 升序：X2(10) → X1(20) → M2(50) → M1(80) → L1(90)
assert(r3[0].name==='早期2' && r3[0].progress==='10', 'progress 升序第一是 progress=10');
assert(r3[4].name==='晚期1' && r3[4].progress==='90', 'progress 升序最后是 progress=90');
// 早期项目(10/20)不因硬分组被提到前面
assert(r3[0].name==='早期2' && r3[1].name==='早期1', 'progress 升序时早期 2 个排前面（非百元含权排序不触发硬分组）');

// 测试4：_kind 缺失的旧场景（不注入），确认硬分组不生效（bug 重现）
console.log('--- _kind 缺失的旧数据（重现原 bug）---');
const oldRows=rows.map(r=>{const copy={...r};delete copy._kind;return copy;});
const r4=doSort(oldRows,{field:"baiyuan",dir:-1});
console.log('  顺序: '+r4.map(r=>r.name).join(' → '));
// 期望：早期1(50) → 早期2(40) → M1(30) → M2(20) → L1(10)  ← bug：早期在最前
assert(r4[0].name==='早期1', '旧数据：早期1 排第一（bug 现象）');
assert(r4[1].name==='早期2', '旧数据：早期2 排第二（bug 现象）');

console.log('\\n========== '+pass+' 通过, '+fail+' 失败 ==========');
process.exit(fail?1:0);
