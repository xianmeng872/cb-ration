// 验证 renderPend 放宽过滤 + stageTagOf 标签语义
// 用法: node test_render_pend.cjs
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const html = fs.readFileSync('index.html', 'utf8');

// 1) 提取真实 stageTagOf 函数源码
const m = html.match(/function stageTagOf\(r\)\{[\s\S]*?\n\}/);
if (!m) { console.error('✗ stageTagOf 未找到'); process.exit(1); }
let fnSrc = m[0];
// 固定"今天"为 2026-07-31，脱离沙箱真实日期影响
fnSrc = fnSrc.replace('todayStr()', "'2026-07-31'");

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1280, height: 800 }
  });
  const page = await browser.newPage();
  const filePath = 'file:///' + path.resolve('index.html').replace(/\\/g, '/');
  await page.goto(filePath, { waitUntil: 'networkidle0', timeout: 20000 });
  await new Promise(r => setTimeout(r, 600));

  const res = await page.evaluate((src) => {
    eval(src); // 在页面上下文定义 stageTagOf（页面已有 todayStr 等依赖）
    const cases = [
      { r: { stage: '申购', publicStart: '2026-08-03 00:00:00' }, exp: '申购',   desc: '未来申购日→申购' },
      { r: { stage: '申购', publicStart: '2026-07-28 00:00:00' }, exp: '待上市', desc: '已过申购日→待上市' },
      { r: { stage: '申购', publicStart: '2026-07-14 00:00:00' }, exp: '待上市', desc: '很早申购已过→待上市' },
      { r: { stage: '待发行' },                            exp: '待发行', desc: '待发行' },
      { r: { stage: '', publicStart: '' },                exp: '待发',   desc: '空stage兜底→待发' },
      { r: {},                                            exp: '待发',   desc: '无字段兜底→待发' },
    ];
    return cases.map(c => {
      const tag = stageTagOf(c.r);
      const ok = tag.indexOf(c.exp) >= 0;
      return { desc: c.desc, exp: c.exp, got: tag.replace(/<[^>]+>/g, ''), ok };
    });
  }, fnSrc);

  await browser.close();

  console.log('=== stageTagOf 标签语义验证（今天=2026-07-31）===');
  let fail = 0;
  res.forEach(r => {
    console.log((r.ok ? '✓' : '✗') + ' ' + r.desc + ' → 期望含「' + r.exp + '」 实际「' + r.got + '」');
    if (!r.ok) fail++;
  });
  if (fail) { console.error('\n✗ ' + fail + ' 项失败'); process.exit(1); }
  console.log('\n✓ 全部 ' + res.length + ' 项通过');
})();
