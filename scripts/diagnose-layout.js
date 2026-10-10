/**
 * 页面布局诊断工具：分析指定URL的DOM层级和各元素占位情况
 * 用法: node scripts/diagnose-layout.js <url>
 * 示例: node scripts/diagnose-layout.js https://xmsyj.moa.gov.cn/gzdt/202606/t20260609_6484841.htm
 */
const puppeteer = require('puppeteer');
const config = require('../config');

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

  // 诊断：分析 body 直接子元素的布局
  const diagnosis = await page.evaluate(() => {
    const results = [];

    // 1. body 直接子元素
    const bodyChildren = Array.from(document.body.children);
    let cumTop = 0;
    for (const child of bodyChildren) {
      const rect = child.getBoundingClientRect();
      const style = getComputedStyle(child);
      results.push({
        tag: child.tagName,
        id: child.id || '',
        className: (child.className || '').toString().slice(0, 80),
        top: Math.round(rect.top),
        height: Math.round(rect.height),
        bottom: Math.round(rect.bottom),
        marginTop: style.marginTop,
        marginBottom: style.marginBottom,
        paddingTop: style.paddingTop,
        paddingBottom: style.paddingBottom,
        position: style.position,
        display: style.display,
        overflow: style.overflow,
      });
    }

    // 2. 查找内容 div
    const contentSelectors = [
      '.sj_arc_body', '.article-content', '.TRS_Editor',
      '.Custom_UnionStyle', '.pages_content', '#content',
      '.content', 'article', 'main',
    ];
    let contentInfo = null;
    for (const sel of contentSelectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetHeight > 100) {
        const rect = el.getBoundingClientRect();
        contentInfo = {
          selector: sel,
          top: Math.round(rect.top),
          height: Math.round(rect.height),
          // 向上遍历父元素
          ancestors: [],
        };
        let parent = el.parentElement;
        while (parent && parent !== document.body) {
          const pRect = parent.getBoundingClientRect();
          const pStyle = getComputedStyle(parent);
          contentInfo.ancestors.push({
            tag: parent.tagName,
            id: parent.id || '',
            className: (parent.className || '').toString().slice(0, 60),
            top: Math.round(pRect.top),
            height: Math.round(pRect.height),
            marginTop: pStyle.marginTop,
            marginBottom: pStyle.marginBottom,
            paddingTop: pStyle.paddingTop,
            paddingBottom: pStyle.paddingBottom,
            position: pStyle.position,
          });
          parent = parent.parentElement;
        }
        contentInfo.ancestors.reverse();
        break;
      }
    }

    // 3. 检查是否有 fixed/sticky 定位的大面积元素
    const fixedElements = [];
    document.querySelectorAll('*').forEach((el) => {
      const style = getComputedStyle(el);
      if ((style.position === 'fixed' || style.position === 'sticky') && el.offsetHeight > 50) {
        fixedElements.push({
          tag: el.tagName,
          className: (el.className || '').toString().slice(0, 60),
          height: el.offsetHeight,
          top: style.top,
        });
      }
    });

    return { bodyChildren: results, contentInfo, fixedElements, bodyHeight: document.body.scrollHeight };
  });

  console.log('='.repeat(70));
  console.log('📋 布局诊断报告');
  console.log('='.repeat(70));

  console.log(`\n📄 页面总高度: ${diagnosis.bodyHeight}px`);

  // 输出 body 子元素
  console.log('\n── body 直接子元素 ──');
  console.log('序号  标签      ID/Class                              Top    Height  Margin(T/B)     Padding(T/B)');
  console.log('-'.repeat(100));
  diagnosis.bodyChildren.forEach((el, i) => {
    const idClass = el.id ? `#${el.id}` : el.className.slice(0, 30);
    console.log(
      `${String(i + 1).padStart(2)}    ${el.tag.padEnd(8)} ${idClass.padEnd(38)} ${String(el.top).padStart(5)}  ${String(el.height).padStart(7)}  ${el.marginTop}/${el.marginBottom.padEnd(6)}   ${el.paddingTop}/${el.paddingBottom}`
    );
  });

  // 输出内容 div 信息
  if (diagnosis.contentInfo) {
    const ci = diagnosis.contentInfo;
    console.log(`\n── 内容区域: ${ci.selector} ──`);
    console.log(`  顶部偏移: ${ci.top}px`);
    console.log(`  内容高度: ${ci.height}px`);
    console.log(`  祖先链 (从body到内容):`);
    ci.ancestors.forEach((a, i) => {
      const indent = '  ' + '  '.repeat(i + 1);
      const idClass = a.id ? `#${a.id}` : a.className.slice(0, 30);
      console.log(`${indent}${a.tag} ${idClass} | top:${a.top} h:${a.height} | margin:${a.marginTop}/${a.marginBottom} | padding:${a.paddingTop}/${a.paddingBottom} | pos:${a.position}`);
    });
  }

  // 输出 fixed 元素
  if (diagnosis.fixedElements.length > 0) {
    console.log(`\n── Fixed/Sticky 元素 ──`);
    diagnosis.fixedElements.forEach((el) => {
      console.log(`  ${el.tag} .${el.className} | height:${el.height} top:${el.top}`);
    });
  }

  // 关键分析
  if (diagnosis.contentInfo) {
    const ci = diagnosis.contentInfo;
    console.log('\n' + '='.repeat(70));
    console.log('🔍 分析结论');
    console.log('='.repeat(70));

    if (ci.top > 800) {
      console.log(`\n⚠️  内容偏移 ${ci.top}px，远超一屏高度！`);
      console.log('可能原因：');

      // 检查祖先链中是否有大偏移的容器
      const bigGapAncestors = ci.ancestors.filter((a) => a.top > 300 && a.height < 100);
      if (bigGapAncestors.length > 0) {
        console.log('  1. 祖先容器有大偏移但高度很小（空占位容器）：');
        bigGapAncestors.forEach((a) => {
          console.log(`     - ${a.tag} top:${a.top} height:${a.height} margin:${a.marginTop}/${a.marginBottom}`);
        });
      }

      // 检查 body 子元素中是否有很高的非内容元素
      const tallChildren = diagnosis.bodyChildren.filter((el) => el.height > 300 && el.top < ci.top);
      if (tallChildren.length > 0) {
        console.log('  2. body 中有占位很高的大元素：');
        tallChildren.forEach((el) => {
          const idClass = el.id ? `#${el.id}` : el.className.slice(0, 40);
          console.log(`     - ${el.tag} ${idClass} | top:${el.top} height:${el.height}`);
        });
      }

      // 检查是否有大 margin
      const bigMarginAncestors = ci.ancestors.filter((a) => parseFloat(a.marginTop) > 20 || parseFloat(a.paddingTop) > 20);
      if (bigMarginAncestors.length > 0) {
        console.log('  3. 祖先容器有大 margin/padding：');
        bigMarginAncestors.forEach((a) => {
          console.log(`     - ${a.tag} margin-top:${a.marginTop} padding-top:${a.paddingTop}`);
        });
      }
    } else if (ci.top > 400) {
      console.log(`\n⚠️  内容偏移 ${ci.top}px，偏大但不算严重`);
    } else {
      console.log(`\n✅ 内容偏移 ${ci.top}px，布局正常`);
    }
  }

  console.log('\n按 Ctrl+C 退出');
  // 保持浏览器打开以便手动检查
}

main().catch(console.error);