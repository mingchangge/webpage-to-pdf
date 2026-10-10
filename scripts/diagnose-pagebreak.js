/**
 * PDF 分页诊断：检查 page-break-inside: avoid 导致内容被推到第二页
 * 用法: node scripts/diagnose-pagebreak.js <url>
 */
const puppeteer = require('puppeteer');
const config = require('../config');

async function main() {
  const url = process.argv.find((arg) => arg.startsWith('http'));
  if (!url) {
    console.error('用法: node scripts/diagnose-pagebreak.js <url>');
    process.exit(1);
  }

  const browser = await puppeteer.launch({ ...config.browser, headless: true });
  const page = await browser.newPage();
  await page.setViewport(config.viewport);
  await page.setUserAgent(config.userAgent);

  console.log(`正在加载: ${url}\n`);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });
  await new Promise((r) => setTimeout(r, 3000));

  // 切换到打印模式
  await page.emulateMediaType('print');

  // 检查内容区及其祖先的 page-break 属性
  const result = await page.evaluate(() => {
    const contentSelectors = [
      '.sj_arc_body', '.article-content', '.TRS_Editor',
      '.Custom_UnionStyle', '.pages_content', '#content',
      '.content', 'article', 'main',
    ];

    // A4 @96DPI: 794x1123px, 减去上下边距20mm=76px each, 可用高度≈971px
    const PAGE_USABLE_HEIGHT = 971;

    let contentEl = null;
    let matchedSelector = '';
    for (const sel of contentSelectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetHeight > 100) {
        contentEl = el;
        matchedSelector = sel;
        break;
      }
    }

    if (!contentEl) return { found: false };

    const contentRect = contentEl.getBoundingClientRect();
    const contentDocTop = contentRect.top + window.scrollY;

    // 检查内容元素及所有祖先的 page-break 属性
    const chain = [];
    let el = contentEl;
    while (el) {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const docTop = rect.top + window.scrollY;
      chain.push({
        tag: el.tagName,
        id: el.id || '',
        className: (el.className || '').toString().slice(0, 50),
        docTop: Math.round(docTop),
        height: Math.round(rect.height),
        pageBreakInside: style.pageBreakInside,
        pageBreakBefore: style.pageBreakBefore,
        pageBreakAfter: style.pageBreakAfter,
        breakInside: style.breakInside || '',
        breakBefore: style.breakBefore || '',
        breakAfter: style.breakAfter || '',
        overflow: style.overflow,
        marginTop: style.marginTop,
        paddingTop: style.paddingTop,
      });
      el = el.parentElement;
    }
    chain.reverse();

    // 计算第一页剩余空间
    const remainingOnPage1 = PAGE_USABLE_HEIGHT - contentDocTop;

    // 检查所有 @media print 规则中的 page-break 相关设置
    const printBreakRules = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule.type === CSSRule.MEDIA_RULE && rule.conditionText && rule.conditionText.includes('print')) {
            for (const r of rule.cssRules) {
              if (r.style && r.selectorText) {
                const props = {};
                for (const prop of ['page-break-inside', 'page-break-before', 'page-break-after', 'break-inside', 'break-before', 'break-after']) {
                  if (r.style[prop]) props[prop] = r.style[prop];
                }
                if (Object.keys(props).length > 0) {
                  printBreakRules.push({ selector: r.selectorText, props });
                }
              }
            }
          }
        }
      } catch (e) {}
    }

    // 也检查非 media print 的规则（全局生效）
    const globalBreakRules = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule.type === CSSRule.STYLE_RULE && rule.style && rule.selectorText) {
            const props = {};
            for (const prop of ['page-break-inside', 'break-inside']) {
              if (rule.style[prop] && rule.style[prop] !== 'auto') {
                props[prop] = rule.style[prop];
              }
            }
            if (Object.keys(props).length > 0) {
              globalBreakRules.push({ selector: rule.selectorText, props });
            }
          }
        }
      } catch (e) {}
    }

    return {
      found: true,
      selector: matchedSelector,
      contentDocTop: Math.round(contentDocTop),
      contentHeight: Math.round(contentRect.height),
      remainingOnPage1: Math.round(remainingOnPage1),
      pageUsableHeight: PAGE_USABLE_HEIGHT,
      chain,
      printBreakRules,
      globalBreakRules,
    };
  });

  if (!result.found) {
    console.log('未找到内容区域');
    await browser.close();
    return;
  }

  console.log('═'.repeat(70));
  console.log('📋 PDF 分页诊断报告');
  console.log('═'.repeat(70));

  console.log(`\n── 基本计算 ──`);
  console.log(`  A4 可用高度: ${result.pageUsableHeight}px (297mm - 40mm边距)`);
  console.log(`  内容区: ${result.selector}`);
  console.log(`  内容文档顶部: ${result.contentDocTop}px`);
  console.log(`  内容高度: ${result.contentHeight}px`);
  console.log(`  第一页剩余空间: ${result.remainingOnPage1}px`);

  if (result.remainingOnPage1 < result.contentHeight && result.remainingOnPage1 > 0) {
    console.log(`\n  ⚠️  内容(${result.contentHeight}px)无法完全放入第一页剩余空间(${result.remainingOnPage1}px)`);
    console.log(`  如果内容元素有 page-break-inside: avoid，整个内容块会被推到第二页！`);
  }

  console.log(`\n── 内容元素 → body 的 page-break 属性链 ──`);
  console.log('  标签      ID/Class                           DocTop  Height  break-inside    break-before    break-after');
  console.log('  ' + '-'.repeat(110));
  result.chain.forEach((item) => {
    const idClass = item.id ? `#${item.id}` : item.className.slice(0, 25);
    const bi = item.breakInside || item.pageBreakInside;
    const bb = item.breakBefore || item.pageBreakBefore;
    const ba = item.breakAfter || item.pageBreakAfter;
    const warn = (bi === 'avoid' || bi === 'avoid-page') ? ' ⚠️' : '';
    console.log(`  ${item.tag.padEnd(9)} ${idClass.padEnd(34)} ${String(item.docTop).padStart(6)}  ${String(item.height).padStart(6)}  ${bi.padEnd(15)} ${bb.padEnd(16)} ${ba}${warn}`);
  });

  // 检查 @media print 中的 page-break 规则
  if (result.printBreakRules.length > 0) {
    console.log(`\n── @media print 中的 page-break 规则 ──`);
    result.printBreakRules.forEach((r) => {
      console.log(`  ${r.selector} { ${Object.entries(r.props).map(([k, v]) => `${k}: ${v}`).join('; ')} }`);
    });
  }

  // 检查全局 page-break-inside: avoid 规则
  if (result.globalBreakRules.length > 0) {
    console.log(`\n── 全局 page-break-inside: avoid 规则 ──`);
    result.globalBreakRules.forEach((r) => {
      console.log(`  ${r.selector} { ${Object.entries(r.props).map(([k, v]) => `${k}: ${v}`).join('; ')} }`);
    });
  }

  // 结论
  console.log(`\n${'═'.repeat(70)}`);
  console.log('🔍 结论');
  console.log(`${'═'.repeat(70)}`);

  const avoidElements = result.chain.filter((item) => {
    const bi = item.breakInside || item.pageBreakInside;
    return bi === 'avoid' || bi === 'avoid-page';
  });

  if (avoidElements.length > 0 && result.remainingOnPage1 < result.contentHeight) {
    console.log(`\n  🎯 找到根因！`);
    console.log(`  以下元素设置了 page-break-inside: avoid：`);
    avoidElements.forEach((item) => {
      const idClass = item.id ? `#${item.id}` : item.className;
      console.log(`    - ${item.tag} ${idClass} (高度: ${item.height}px)`);
    });
    console.log(`\n  内容高度 ${result.contentHeight}px > 第一页剩余 ${result.remainingOnPage1}px`);
    console.log(`  Chromium 不允许在此元素内分页，所以把整个块推到第二页`);
    console.log(`\n  💡 修复方案：生成PDF前注入CSS：`);
    avoidElements.forEach((item) => {
      const sel = item.id ? `#${item.id}` : (item.className ? `.${item.className.split(' ')[0]}` : item.tag);
      console.log(`    ${sel} { page-break-inside: auto !important; break-inside: auto !important; }`);
    });
  } else if (result.remainingOnPage1 <= 0) {
    console.log(`\n  内容顶部已超出第一页，问题在于头部区域过大`);
    console.log(`  💡 修复方案：减少头部区域的 margin/padding`);
  } else {
    console.log(`\n  未检测到 page-break-inside: avoid 问题`);
    console.log(`  可能是其他原因导致分页异常，建议生成PDF后检查`);
  }

  // 生成一个测试PDF看看实际效果
  console.log(`\n── 生成测试PDF ──`);
  const testPath = '/tmp/test-pagebreak.pdf';
  await page.pdf({
    path: testPath,
    format: 'A4',
    printBackground: true,
    margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
  });
  console.log(`  已保存: ${testPath}`);

  // 再生成一个修复后的PDF
  console.log(`\n── 生成修复后PDF ──`);
  if (avoidElements.length > 0) {
    // 注入修复CSS
    let fixCss = '';
    avoidElements.forEach((item) => {
      const sel = item.id ? `#${item.id}` : (item.className ? `.${item.className.split(' ')[0]}` : item.tag);
      fixCss += `${sel} { page-break-inside: auto !important; break-inside: auto !important; }\n`;
    });
    await page.addStyleTag({ content: fixCss });
    const fixPath = '/tmp/test-pagebreak-fixed.pdf';
    await page.pdf({
      path: fixPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
    });
    console.log(`  已保存: ${fixPath}`);
    console.log(`  请对比两个PDF，确认修复效果`);
  }

  await browser.close();
}

main().catch(console.error);