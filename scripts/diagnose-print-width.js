/**
 * 在打印宽度(680px)下诊断布局，并生成修复前后对比PDF
 * 用法: node scripts/diagnose-print-width.js <url>
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const config = require('../config');

const PRINT_WIDTH = 680; // A4(210mm) - 左右边距(30mm) = 180mm ≈ 680px@96DPI
const A4_USABLE_HEIGHT = 971; // A4(297mm) - 上下边距(40mm) ≈ 971px@96DPI

async function main() {
  const url = process.argv.find((arg) => arg.startsWith('http'));
  if (!url) {
    console.error('用法: node scripts/diagnose-print-width.js <url>');
    process.exit(1);
  }

  const browser = await puppeteer.launch({ ...config.browser, headless: true });
  const page = await browser.newPage();
  await page.setUserAgent(config.userAgent);

  // 关键：设置视口为打印宽度
  await page.setViewport({ width: PRINT_WIDTH, height: 1200 });
  console.log(`视口宽度设为 ${PRINT_WIDTH}px (模拟A4打印宽度)\n`);

  console.log(`正在加载: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });
  await new Promise((r) => setTimeout(r, 3000));

  // 切换到打印媒体
  await page.emulateMediaType('print');
  await new Promise((r) => setTimeout(r, 500));

  // 在打印宽度下诊断布局
  const diag = await page.evaluate((PRINT_WIDTH, A4_USABLE_HEIGHT) => {
    const contentSelectors = [
      '.sj_arc_body', '.article-content', '.TRS_Editor',
      '.Custom_UnionStyle', '.pages_content', '#content',
      '.content', 'article', 'main',
    ];

    // body 子元素
    const bodyChildren = Array.from(document.body.children).map((child) => {
      const rect = child.getBoundingClientRect();
      const style = getComputedStyle(child);
      return {
        tag: child.tagName,
        id: child.id || '',
        cls: (child.className || '').toString().slice(0, 40),
        docTop: Math.round(rect.top + window.scrollY),
        height: Math.round(rect.height),
        marginTop: style.marginTop,
        paddingTop: style.paddingTop,
        overflow: style.overflow,
        pageBreakBefore: style.pageBreakBefore,
        pageBreakInside: style.pageBreakInside,
      };
    });

    // 内容区
    let contentEl = null;
    let contentSel = '';
    for (const sel of contentSelectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetHeight > 100) {
        contentEl = el;
        contentSel = sel;
        break;
      }
    }

    let contentInfo = null;
    if (contentEl) {
      const rect = contentEl.getBoundingClientRect();
      const docTop = Math.round(rect.top + window.scrollY);
      contentInfo = {
        selector: contentSel,
        docTop,
        height: Math.round(rect.height),
        remainingOnPage1: A4_USABLE_HEIGHT - docTop,
        // 祖先链
        ancestors: [],
      };
      let parent = contentEl.parentElement;
      while (parent) {
        const pRect = parent.getBoundingClientRect();
        const pStyle = getComputedStyle(parent);
        contentInfo.ancestors.push({
          tag: parent.tagName,
          id: parent.id || '',
          cls: (parent.className || '').toString().slice(0, 40),
          docTop: Math.round(pRect.top + window.scrollY),
          height: Math.round(pRect.height),
          marginTop: pStyle.marginTop,
          paddingTop: pStyle.paddingTop,
          overflow: pStyle.overflow,
          pageBreakInside: pStyle.pageBreakInside,
          pageBreakBefore: pStyle.pageBreakBefore,
        });
        parent = parent.parentElement;
      }
      contentInfo.ancestors.reverse();
    }

    // 深度检查：内容区内部所有子元素的 page-break 和 overflow
    let internalProblems = [];
    if (contentEl) {
      contentEl.querySelectorAll('*').forEach((el) => {
        const style = getComputedStyle(el);
        const problems = [];
        if (style.pageBreakInside === 'avoid') problems.push('page-break-inside:avoid');
        if (style.breakInside === 'avoid' || style.breakInside === 'avoid-page') problems.push('break-inside:avoid');
        if (style.overflow === 'hidden' || style.overflowX === 'hidden' || style.overflowY === 'hidden') problems.push('overflow:hidden');
        if (style.pageBreakBefore === 'always' || style.pageBreakBefore === 'left' || style.pageBreakBefore === 'right') problems.push('page-break-before:' + style.pageBreakBefore);
        if (problems.length > 0) {
          internalProblems.push({
            tag: el.tagName,
            cls: (el.className || '').toString().slice(0, 40),
            height: el.offsetHeight,
            problems,
          });
        }
      });
    }

    return { viewportWidth: window.innerWidth, bodyChildren, contentInfo, internalProblems };
  }, PRINT_WIDTH, A4_USABLE_HEIGHT);

  // 输出诊断
  console.log('═'.repeat(70));
  console.log(`📋 打印宽度(${diag.viewportWidth}px)下的布局诊断`);
  console.log('═'.repeat(70));

  console.log(`\n── body 直接子元素 ──`);
  diag.bodyChildren
    .filter((el) => el.height > 0 && el.tag !== 'SCRIPT' && el.tag !== 'STYLE')
    .forEach((el, i) => {
      const idc = el.id ? '#' + el.id : el.cls.slice(0, 25);
      console.log(`  ${i + 1}. ${el.tag} ${idc} | top:${el.docTop} h:${el.height} | m-top:${el.marginTop} p-top:${el.paddingTop} | overflow:${el.overflow} | pb-inside:${el.pageBreakInside} pb-before:${el.pageBreakBefore}`);
    });

  if (diag.contentInfo) {
    const ci = diag.contentInfo;
    console.log(`\n── 内容区: ${ci.selector} ──`);
    console.log(`  文档顶部: ${ci.docTop}px`);
    console.log(`  内容高度: ${ci.height}px`);
    console.log(`  第一页剩余: ${ci.remainingOnPage1}px`);
    console.log(`  A4可用高度: ${A4_USABLE_HEIGHT}px`);

    if (ci.docTop > A4_USABLE_HEIGHT) {
      console.log(`\n  🎯 根因找到了！内容顶部 ${ci.docTop}px > A4可用 ${A4_USABLE_HEIGHT}px`);
      console.log(`  在打印宽度下，头部区域已经超过一页，内容自然被推到第二页！`);
    } else if (ci.remainingOnPage1 < ci.height && ci.remainingOnPage1 > 0) {
      console.log(`\n  ⚠️  内容(${ci.height}px)放不进第一页剩余(${ci.remainingOnPage1}px)`);
    }

    console.log(`\n  祖先链:`);
    ci.ancestors.forEach((a, i) => {
      const indent = '  ' + '  '.repeat(i);
      const idc = a.id ? '#' + a.id : a.cls.slice(0, 20);
      console.log(`${indent}${a.tag} ${idc} | top:${a.docTop} h:${a.height} | m:${a.marginTop} p:${a.paddingTop} | overflow:${a.overflow} | pb-inside:${a.pageBreakInside}`);
    });
  }

  if (diag.internalProblems.length > 0) {
    console.log(`\n── 内容区内部有问题的子元素 ──`);
    diag.internalProblems.forEach((p) => {
      console.log(`  ${p.tag} .${p.cls} | h:${p.height}px | ${p.problems.join(', ')}`);
    });
  }

  // 生成3个对比PDF
  const pdfConfig = {
    format: 'A4',
    printBackground: true,
    margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
  };

  console.log(`\n── 生成对比PDF ──`);

  // 1. 原始PDF
  const p1 = '/tmp/pdf-original.pdf';
  await page.pdf({ path: p1, ...pdfConfig });
  console.log(`  1. 原始: ${p1}`);

  // 2. 注入page-break修复
  await page.addStyleTag({
    content: `
      * { page-break-inside: auto !important; break-inside: auto !important; }
      .sj_arc_body, .sj_er_kuang_xiang, #main { overflow: visible !important; }
    `,
  });
  const p2 = '/tmp/pdf-fix-break.pdf';
  await page.pdf({ path: p2, ...pdfConfig });
  console.log(`  2. 修复page-break: ${p2}`);

  // 3. 激进修复：压缩头部间距
  await page.addStyleTag({
    content: `
      #top, .top { height: auto !important; min-height: 0 !important; margin: 0 !important; padding: 2px 0 !important; }
      #header, .header { height: auto !important; min-height: 0 !important; margin: 0 !important; padding: 5px 10px !important; }
      #main, .main { margin-top: 0 !important; padding-top: 0 !important; }
      .sj_er_kuang_xiang { margin-top: 0 !important; padding-top: 10px !important; }
    `,
  });
  const p3 = '/tmp/pdf-fix-aggressive.pdf';
  await page.pdf({ path: p3, ...pdfConfig });
  console.log(`  3. 激进修复(压缩头部): ${p3}`);

  console.log(`\n请打开这3个PDF对比，看哪个修复了首页空白问题`);

  await browser.close();
}

main().catch(console.error);