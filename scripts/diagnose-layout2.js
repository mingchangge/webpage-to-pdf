/**
 * 页面布局诊断工具：对比屏幕模式和打印模式的布局差异
 * 用法: node scripts/diagnose-layout.js <url>
 * 示例: node scripts/diagnose-layout.js https://xmsyj.moa.gov.cn/gzdt/202606/t20260609_6484841.htm
 */
const puppeteer = require('puppeteer');
const config = require('../config');

// 提取布局信息的通用函数
async function extractLayout(page) {
  return page.evaluate(() => {
    const contentSelectors = [
      '.sj_arc_body', '.article-content', '.TRS_Editor',
      '.Custom_UnionStyle', '.pages_content', '#content',
      '.content', 'article', 'main',
    ];

    // body 自身样式
    const bodyStyle = getComputedStyle(document.body);
    const bodyInfo = {
      marginTop: bodyStyle.marginTop,
      marginBottom: bodyStyle.marginBottom,
      paddingTop: bodyStyle.paddingTop,
      paddingBottom: bodyStyle.paddingBottom,
      scrollHeight: document.body.scrollHeight,
      offsetHeight: document.body.offsetHeight,
    };

    // body 直接子元素（使用文档坐标 top + scrollY）
    const bodyChildren = Array.from(document.body.children).map((child) => {
      const rect = child.getBoundingClientRect();
      const style = getComputedStyle(child);
      return {
        tag: child.tagName,
        id: child.id || '',
        className: (child.className || '').toString().slice(0, 80),
        top: Math.round(rect.top + window.scrollY),
        height: Math.round(rect.height),
        marginTop: style.marginTop,
        marginBottom: style.marginBottom,
        paddingTop: style.paddingTop,
        paddingBottom: style.paddingBottom,
        position: style.position,
        display: style.display,
        overflow: style.overflow,
        pageBreakBefore: style.pageBreakBefore,
      };
    });

    // 查找内容 div
    let contentInfo = null;
    for (const sel of contentSelectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetHeight > 100) {
        const rect = el.getBoundingClientRect();
        contentInfo = {
          selector: sel,
          top: Math.round(rect.top + window.scrollY),
          height: Math.round(rect.height),
          ancestors: [],
        };
        let parent = el.parentElement;
        while (parent && parent !== document.body) {
          const pRect = parent.getBoundingClientRect();
          const pStyle = getComputedStyle(parent);
          contentInfo.ancestors.push({
            tag: parent.tagName,
            id: parent.id || '',
            className: (parent.className || '').toString().slice(0, 50),
            top: Math.round(pRect.top + window.scrollY),
            height: Math.round(pRect.height),
            marginTop: pStyle.marginTop,
            marginBottom: pStyle.marginBottom,
            paddingTop: pStyle.paddingTop,
            paddingBottom: pStyle.paddingBottom,
            position: pStyle.position,
            pageBreakBefore: pStyle.pageBreakBefore,
          });
          parent = parent.parentElement;
        }
        contentInfo.ancestors.reverse();
        break;
      }
    }

    // 检查 @media print 样式规则
    const printRules = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule.type === CSSRule.MEDIA_RULE && rule.conditionText && rule.conditionText.includes('print')) {
            for (const r of rule.cssRules) {
              if (r.style && r.selectorText) {
                const props = {};
                for (const prop of ['margin-top', 'margin-bottom', 'padding-top', 'padding-bottom', 'display', 'position', 'page-break-before', 'page-break-after', 'height', 'min-height', 'visibility']) {
                  if (r.style[prop]) props[prop] = r.style[prop];
                }
                if (Object.keys(props).length > 0) {
                  printRules.push({ selector: r.selectorText, props });
                }
              }
            }
          }
        }
      } catch (e) { /* 跨域样式表无法访问 */ }
    }

    return { bodyInfo, bodyChildren, contentInfo, printRules };
  });
}

function printLayout(label, data) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`📋 ${label}`);
  console.log(`${'═'.repeat(70)}`);

  console.log(`\n── body 样式 ──`);
  console.log(`  margin: ${data.bodyInfo.marginTop} / ${data.bodyInfo.marginBottom}`);
  console.log(`  padding: ${data.bodyInfo.paddingTop} / ${data.bodyInfo.paddingBottom}`);
  console.log(`  scrollHeight: ${data.bodyInfo.scrollHeight}px, offsetHeight: ${data.bodyInfo.offsetHeight}px`);

  console.log(`\n── body 直接子元素 (文档坐标) ──`);
  console.log('序号  标签      ID/Class                              Top    Height  Margin(T/B)     Padding(T/B)     Pos        PageBreak');
  console.log('-'.repeat(120));
  data.bodyChildren.forEach((el, i) => {
    if ((el.height === 0 && el.tag === 'SCRIPT') || el.tag === 'STYLE') return;
    const idClass = el.id ? `#${el.id}` : el.className.slice(0, 30);
    console.log(
      `${String(i + 1).padStart(2)}    ${el.tag.padEnd(8)} ${idClass.padEnd(38)} ${String(el.top).padStart(5)}  ${String(el.height).padStart(7)}  ${el.marginTop}/${el.marginBottom.padEnd(6)}   ${el.paddingTop}/${el.paddingBottom.padEnd(6)}   ${el.position.padEnd(9)} ${el.pageBreakBefore}`
    );
  });

  if (data.contentInfo) {
    const ci = data.contentInfo;
    console.log(`\n── 内容区域: ${ci.selector} ──`);
    console.log(`  文档顶部: ${ci.top}px, 高度: ${ci.height}px`);
    console.log(`  祖先链:`);
    ci.ancestors.forEach((a, i) => {
      const indent = '  ' + '  '.repeat(i + 1);
      const idClass = a.id ? `#${a.id}` : a.className.slice(0, 25);
      console.log(`${indent}${a.tag} ${idClass} | top:${a.top} h:${a.height} | m:${a.marginTop}/${a.marginBottom} | p:${a.paddingTop}/${a.paddingBottom} | pos:${a.position} | pb:${a.pageBreakBefore}`);
    });
  }

  if (data.printRules && data.printRules.length > 0) {
    console.log(`\n── @media print 规则 (影响布局的) ──`);
    data.printRules.forEach((r) => {
      console.log(`  ${r.selector} { ${Object.entries(r.props).map(([k, v]) => `${k}: ${v}`).join('; ')} }`);
    });
  }
}

async function main() {
  const url = process.argv.find((arg) => arg.startsWith('http'));
  if (!url) {
    console.error('用法: node scripts/diagnose-layout.js <url>');
    process.exit(1);
  }

  const browser = await puppeteer.launch({ ...config.browser, headless: false });
  const page = await browser.newPage();
  await page.setViewport({ ...config.viewport, height: 1200 });
  await page.setUserAgent(config.userAgent);

  console.log(`正在加载: ${url}\n`);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });
  await new Promise((r) => setTimeout(r, 3000));

  // 1. 屏幕模式诊断
  await page.emulateMediaType('screen');
  const screenData = await extractLayout(page);
  printLayout('屏幕模式 (screen)', screenData);

  // 2. 打印模式诊断
  await page.emulateMediaType('print');
  await new Promise((r) => setTimeout(r, 1000));
  const printData = await extractLayout(page);
  printLayout('打印模式 (print) ← page.pdf() 使用此模式', printData);

  // 3. 对比分析
  console.log(`\n${'═'.repeat(70)}`);
  console.log('🔍 对比分析');
  console.log(`${'═'.repeat(70)}`);

  if (screenData.contentInfo && printData.contentInfo) {
    const sTop = screenData.contentInfo.top;
    const pTop = printData.contentInfo.top;
    const diff = pTop - sTop;
    console.log(`\n  内容区文档偏移: 屏幕=${sTop}px, 打印=${pTop}px, 差值=${diff}px`);
    if (diff > 200) {
      console.log(`  ⚠️  打印模式比屏幕模式多出 ${diff}px 的顶部空间！这就是PDF首页空白的原因`);
    } else if (diff < -200) {
      console.log(`  ℹ️  打印模式比屏幕模式少 ${Math.abs(diff)}px 的顶部空间`);
    } else {
      console.log(`  ✅ 两种模式偏移差异不大 (${diff}px)`);
    }
  }

  // body 样式差异
  const sBody = screenData.bodyInfo;
  const pBody = printData.bodyInfo;
  console.log(`\n  body margin-top: 屏幕=${sBody.marginTop}, 打印=${pBody.marginTop}`);
  console.log(`  body padding-top: 屏幕=${sBody.paddingTop}, 打印=${pBody.paddingTop}`);

  // 子元素差异
  console.log(`\n  body 子元素变化:`);
  const maxLen = Math.max(screenData.bodyChildren.length, printData.bodyChildren.length);
  for (let i = 0; i < maxLen; i++) {
    const s = screenData.bodyChildren[i];
    const p = printData.bodyChildren[i];
    if (!s || !p) continue;
    if (s.tag === 'SCRIPT' || s.tag === 'STYLE') continue;
    if (s.height !== p.height || s.top !== p.top) {
      const idClass = s.id ? `#${s.id}` : s.className.slice(0, 25);
      console.log(`    ${s.tag} ${idClass}: 屏幕 top=${s.top} h=${s.height} → 打印 top=${p.top} h=${p.height}`);
    }
  }

  // 打印特有规则
  if (printData.printRules && printData.printRules.length > 0) {
    console.log(`\n  ⚠️  发现 ${printData.printRules.length} 条 @media print 规则影响布局！`);
    console.log('  建议在生成PDF前注入CSS覆盖这些规则');
  }

  console.log('\n按 Ctrl+C 退出');
}

main().catch(console.error);