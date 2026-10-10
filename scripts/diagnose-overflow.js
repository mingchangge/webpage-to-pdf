/**
 * 检查内容区祖先链的 overflow 属性
 * overflow: hidden 会导致 Chromium 打印时将容器视为原子盒子，无法内部分页
 * 用法: node scripts/diagnose-overflow.js <url>
 */
const puppeteer = require('puppeteer');
const config = require('../config');

async function main() {
  const url = process.argv.find((arg) => arg.startsWith('http'));
  if (!url) {
    console.error('用法: node scripts/diagnose-overflow.js <url>');
    process.exit(1);
  }

  const browser = await puppeteer.launch({ ...config.browser, headless: true });
  const page = await browser.newPage();
  await page.setViewport(config.viewport);
  await page.setUserAgent(config.userAgent);

  console.log(`正在加载: ${url}\n`);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });
  await new Promise((r) => setTimeout(r, 3000));
  await page.emulateMediaType('print');

  const result = await page.evaluate(() => {
    const el = document.querySelector('.sj_arc_body');
    if (!el) return null;
    const chain = [];
    let cur = el;
    while (cur) {
      const s = getComputedStyle(cur);
      const r = cur.getBoundingClientRect();
      chain.push({
        tag: cur.tagName,
        id: cur.id || '',
        cls: (cur.className || '').toString().slice(0, 40),
        top: Math.round(r.top + window.scrollY),
        h: Math.round(r.height),
        overflow: s.overflow,
        overflowX: s.overflowX,
        overflowY: s.overflowY,
        display: s.display,
        position: s.position,
      });
      cur = cur.parentElement;
    }
    chain.reverse();
    return chain;
  });

  if (!result) {
    console.log('未找到 .sj_arc_body');
    await browser.close();
    return;
  }

  console.log('标签      ID/Class                          Top    H    overflow   overflowX  overflowY  display       position');
  console.log('-'.repeat(110));
  result.forEach((i) => {
    const idc = i.id ? '#' + i.id : i.cls.slice(0, 25);
    const isHidden = i.overflow === 'hidden' || i.overflowX === 'hidden' || i.overflowY === 'hidden';
    const warn = isHidden ? ' ⚠️ overflow:hidden → 打印时不可内部分页' : '';
    console.log(
      i.tag.padEnd(9),
      idc.padEnd(33),
      String(i.top).padStart(5),
      String(i.h).padStart(5),
      i.overflow.padEnd(11),
      i.overflowX.padEnd(11),
      i.overflowY.padEnd(11),
      i.display.padEnd(14),
      i.position,
      warn
    );
  });

  const hiddenItems = result.filter(
    (i) => i.overflow === 'hidden' || i.overflowX === 'hidden' || i.overflowY === 'hidden'
  );
  if (hiddenItems.length > 0) {
    console.log('\n⚠️  发现 overflow:hidden 元素！');
    console.log('Chromium 打印渲染器将 overflow:hidden 容器视为原子盒子，');
    console.log('内容超出一页时整块被推到下一页，导致首页空白。');
    console.log('\n💡 修复：生成PDF前注入CSS将 overflow 改为 visible：');
    hiddenItems.forEach((i) => {
      const sel = i.id ? '#' + i.id : (i.cls ? '.' + i.cls.split(' ')[0] : i.tag);
      console.log(`  ${sel} { overflow: visible !important; }`);
    });
  }

  await browser.close();
}

main().catch(console.error);