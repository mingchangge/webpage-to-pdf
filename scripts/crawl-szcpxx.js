/**
 * 爬取"生猪专题·月度数据"的3个页面，生成PDF到 output/pdfs/
 * 策略：移除左侧边栏 + 强制表格自适应宽度 + page.pdf({scale}) 缩放
 * 注意：CSS zoom 在打印渲染中不生效，必须用 page.pdf 的 scale 参数
 * 用法: node scripts/crawl-szcpxx.js
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const config = require('../config');
const { generatePdfFilename, ensureDir, delay, formatFileSize } = require('../src/utils');

const OUTPUT_DIR = path.join(__dirname, '..', 'output', 'pdfs');

// PDF生成层面的缩放比例（page.pdf 的 scale 参数），0.78 = 缩到78%
// 这是唯一在打印渲染中生效的缩放方式，CSS zoom/transform:scale 均无效
const PDF_SCALE = 0.78;

const TARGET_URLS = [
  {
    url: 'https://www.moa.gov.cn/ztzl/szcpxx/jdsj/2023/202308',
    title: '生猪专题·月度数据（2023年8月）',
  },
  {
    url: 'https://www.moa.gov.cn/ztzl/szcpxx/jdsj/2025/202508',
    title: '生猪专题·月度数据（2025年8月）',
  },
  {
    url: 'https://www.moa.gov.cn/ztzl/szcpxx/jdsj/2026/202604',
    title: '生猪专题·月度数据（2026年4月）',
  },
];

async function crawlSzcpxxPage(browser, item) {
  const { url, title } = item;
  const filename = generatePdfFilename(item);
  const outputPath = path.join(OUTPUT_DIR, filename);

  console.log(`\n正在处理: ${title}`);
  console.log(`  URL: ${url}`);

  const page = await browser.newPage();

  try {
    await page.setUserAgent(config.userAgent);
    await page.setViewport(config.viewport);

    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (['media'].includes(request.resourceType())) {
        request.abort();
      } else {
        request.continue();
      }
    });

    console.log('  → 正在加载页面...');
    await page.goto(url, {
      waitUntil: config.page.waitUntil,
      timeout: config.page.longTimeout || 120000,
    });
    await delay(config.page.extraWait);

    // 移除非内容元素（复用全局配置）
    const removedCount = await page.evaluate((selectors) => {
      let count = 0;
      for (const selector of selectors) {
        document.querySelectorAll(selector).forEach((el) => {
          el.remove();
          count++;
        });
      }
      return count;
    }, config.removeSelectors || []);
    if (removedCount > 0) {
      console.log(`  → 已移除 ${removedCount} 个非内容元素`);
    }

    // 核心处理：移除左侧边栏 + 强制表格自适应宽度
    const sidebarResult = await page.evaluate(() => {
      const left = document.querySelector('.ztst_list_left');
      const right = document.querySelector('.ztst_list_right');

      let removed = false;
      let expanded = false;
      let leftWidth = 0;
      let rightWidth = 0;

      if (left) {
        leftWidth = left.offsetWidth;
        left.remove();
        removed = true;
      }

      if (right) {
        rightWidth = right.offsetWidth;
        right.style.width = '100%';
        right.style.maxWidth = '100%';
        right.style.float = 'none';
        right.style.marginLeft = '0';
        right.style.paddingLeft = '0';
        expanded = true;
      }

      // 处理父容器宽度限制
      const container = document.querySelector('.ztst_list') || document.querySelector('.ztst');
      if (container) {
        container.style.width = '100%';
        container.style.maxWidth = '100%';
      }

      // 强制所有表格自适应容器宽度，移除固定宽度
      let tableCount = 0;
      document.querySelectorAll('table').forEach((table) => {
        table.style.width = '100%';
        table.style.maxWidth = '100%';
        table.style.tableLayout = 'auto';
        table.removeAttribute('width');
        tableCount++;
      });
      // 移除 td/th 上的固定宽度
      document.querySelectorAll('td, th').forEach((cell) => {
        if (cell.style.width && cell.style.width.includes('px')) {
          cell.style.width = 'auto';
        }
        cell.removeAttribute('width');
      });

      return { removed, expanded, leftWidth, rightWidth, tableCount };
    });

    if (sidebarResult.removed) {
      console.log(`  → 已移除左侧边栏 .ztst_list_left（原宽 ${sidebarResult.leftWidth}px）`);
    } else {
      console.log('  ⚠ 未找到 .ztst_list_left，跳过移除');
    }
    if (sidebarResult.expanded) {
      console.log(`  → 右侧内容区 .ztst_list_right 已扩展全宽（原宽 ${sidebarResult.rightWidth}px）`);
    }
    if (sidebarResult.tableCount > 0) {
      console.log(`  → 已强制 ${sidebarResult.tableCount} 个表格 width:100% + table-layout:auto`);
    }

    // 检测内容实际宽度，验证是否仍有溢出
    const widthInfo = await page.evaluate(() => {
      const right = document.querySelector('.ztst_list_right');
      if (!right) return { hasRight: false };
      const scrollWidth = right.scrollWidth;
      const clientWidth = right.clientWidth;
      let maxTableWidth = 0;
      right.querySelectorAll('table').forEach((t) => {
        if (t.scrollWidth > maxTableWidth) maxTableWidth = t.scrollWidth;
      });
      return { hasRight: true, scrollWidth, clientWidth, maxTableWidth };
    });
    if (widthInfo.hasRight) {
      console.log(`  → 内容区宽度: clientWidth=${widthInfo.clientWidth}px, scrollWidth=${widthInfo.scrollWidth}px, 最宽表格=${widthInfo.maxTableWidth}px`);
      if (widthInfo.scrollWidth > widthInfo.clientWidth) {
        console.log(`  ⚠ 内容仍有溢出，PDF scale=${PDF_SCALE} 会进一步缩小`);
      }
    }

    // 切换到打印视口宽度
    const printViewportWidth = 780;
    await page.setViewport({ ...config.viewport, width: printViewportWidth });
    await delay(500);
    await page.evaluate(() => window.scrollTo(0, 0));
    await delay(300);

    // 注入打印分页修复CSS
    await page.addStyleTag({
      content: `
        .sj_arc_body, .sj_arc_body *,
        .article-content, .article-content *,
        .TRS_Editor, .TRS_Editor *,
        .Custom_UnionStyle, .Custom_UnionStyle *,
        .pages_content, .pages_content *,
        #content, #content *,
        .content, .content *,
        article, article *,
        main, main *,
        table, tr, td, th {
          page-break-inside: auto !important;
          break-inside: auto !important;
        }
        h1, h2, h3, h4, h5, h6, p {
          page-break-after: avoid !important;
          break-after: avoid-page !important;
        }
      `,
    });

    ensureDir(OUTPUT_DIR);

    console.log(`  → 正在生成PDF（scale=${PDF_SCALE}）...`);
    await page.pdf({
      path: outputPath,
      ...config.pdf,
      scale: PDF_SCALE,
      timeout: 120000,
    });

    if (fs.existsSync(outputPath)) {
      const stats = fs.statSync(outputPath);
      console.log(`  ✓ PDF已保存: ${filename} (${formatFileSize(stats.size)})`);
      return { url, title, filename, success: true, fileSize: stats.size };
    } else {
      throw new Error('PDF文件未生成');
    }
  } catch (error) {
    console.error(`  ✗ 失败: ${error.message}`);
    return { url, title, filename, success: false, error: error.message };
  } finally {
    await page.close();
  }
}

async function main() {
  ensureDir(OUTPUT_DIR);

  console.log('='.repeat(60));
  console.log('生猪专题·月度数据 爬取脚本');
  console.log('='.repeat(60));
  console.log(`共 ${TARGET_URLS.length} 个页面待处理`);
  console.log(`输出目录: ${OUTPUT_DIR}`);
  console.log(`PDF缩放: scale = ${PDF_SCALE}\n`);

  const browser = await puppeteer.launch(config.browser);
  const results = [];

  try {
    for (let i = 0; i < TARGET_URLS.length; i++) {
      const result = await crawlSzcpxxPage(browser, TARGET_URLS[i]);
      results.push(result);
    }
  } finally {
    await browser.close();
  }

  const reportPath = path.join(OUTPUT_DIR, '_szcpxx-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2), 'utf-8');

  const successCount = results.filter((r) => r.success).length;
  console.log('\n' + '='.repeat(60));
  console.log(`完成: ${successCount}/${TARGET_URLS.length} 个成功`);
  console.log(`文件保存在: ${OUTPUT_DIR}`);
  console.log(`报告: ${reportPath}`);
}

main().catch(console.error);