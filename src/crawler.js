const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const config = require('../config');
const {
  generatePdfFilename,
  ensureDir,
  delay,
  withRetry,
  formatFileSize,
  detectUrlType,
  downloadFile,
  convertToHtml,
} = require('./utils');

/**
 * 处理文档类URL（.doc, .docx, .xls, .xlsx, .ppt, .pptx, .ofd, .pdf等）
 * 核心策略：下载文件 → LibreOffice转HTML → Puppeteer渲染HTML生成PDF
 */
async function handleDocumentUrl(browser, item, filename) {
  const { url, title } = item;
  const outputPath = path.join(config.outputDir, filename);
  const downloadDir = path.join(config.outputDir, '_downloads');
  ensureDir(downloadDir);
  ensureDir(config.outputDir);

  const urlType = detectUrlType(url);
  const urlFilename = url.split('?')[0].split('/').pop() || `file_${Date.now()}`;
  const tempPath = path.join(downloadDir, urlFilename);

  // 下载文件
  console.log(`  → 正在下载 ${urlType.toUpperCase()} 文件...`);
  await downloadFile(url, tempPath);
  const tempSize = fs.statSync(tempPath).size;
  console.log(`  ✓ 已下载: ${urlFilename} (${formatFileSize(tempSize)})`);

  // PDF文件直接复制
  if (urlType === 'pdf') {
    fs.copyFileSync(tempPath, outputPath);
    fs.unlinkSync(tempPath);
    return outputPath;
  }

  // OFD文件：用ofd.js在浏览器中渲染，再生成PDF
  if (urlType === 'ofd') {
    console.log(`  → 正在通过ofd.js渲染OFD...`);
    try {
      const pdfResult = await renderOfdInBrowser(browser, tempPath, outputPath);
      if (pdfResult) {
        fs.unlinkSync(tempPath);
        return outputPath;
      }
    } catch (ofdError) {
      console.log(`  ⚠ ofd.js渲染失败: ${ofdError.message}`);
    }
    // 渲染失败则保留原文件
    const ofdOutput = outputPath.replace(/\.pdf$/, '.ofd');
    fs.copyFileSync(tempPath, ofdOutput);
    fs.unlinkSync(tempPath);
    throw new Error(`OFD渲染失败，已保存原文件: ${path.basename(ofdOutput)}`);
  }

  // doc/docx/xls/xlsx/ppt/pptx：下载 → LibreOffice转HTML → Puppeteer渲染PDF
  const convertibleExts = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'rtf', 'wps'];
  if (convertibleExts.includes(urlType)) {
    console.log(`  → 正在通过LibreOffice转HTML...`);
    try {
      const htmlPath = await convertToHtml(tempPath, downloadDir, config.libreofficePath);
      console.log(`  ✓ 已转HTML: ${path.basename(htmlPath)}`);

      console.log(`  → 正在渲染HTML生成PDF...`);
      const htmlUrl = `file://${htmlPath}`;
      const pdfResult = await renderLocalHtml(browser, htmlUrl, outputPath);

      fs.unlinkSync(tempPath);
      if (fs.existsSync(htmlPath)) fs.unlinkSync(htmlPath);

      if (pdfResult) return outputPath;
      throw new Error('HTML渲染PDF失败');
    } catch (htmlError) {
      console.log(`  ⚠ LibreOffice转HTML失败: ${htmlError.message}`);
    }

    // 备选在线查看器策略
    console.log(`  → 尝试在线查看器渲染...`);
    const msViewerUrl = `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(url)}`;
    try {
      const pdfResult = await renderViewerPage(browser, msViewerUrl, outputPath, 45000);
      if (pdfResult) {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        return outputPath;
      }
    } catch {
      console.log(`  ⚠ 在线查看器也失败`);
    }

    // 保留原文件兜底
    const origOutput = outputPath.replace(/\.pdf$/, `.${urlType}`);
    if (!fs.existsSync(origOutput)) {
      fs.copyFileSync(tempPath, origOutput);
    }
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    throw new Error(`所有转换策略失败，已保存原文件: ${path.basename(origOutput)}`);
  }

  const rawOutput = outputPath.replace(/\.pdf$/, `.${urlType}`);
  fs.copyFileSync(tempPath, rawOutput);
  fs.unlinkSync(tempPath);
  throw new Error(`不支持的格式 .${urlType}，已保存原文件: ${path.basename(rawOutput)}`);
}

/**
 * 用ofd.js在浏览器中渲染OFD文件
 */
async function renderOfdInBrowser(browser, ofdFilePath, outputPath) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ ...config.viewport, height: 1200 });

    const ofdHtml = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #fff; }
  #ofd-container { width: 100%; }
  #ofd-container svg { max-width: 100%; height: auto; }
  #status { padding: 20px; font-size: 18px; color: #666; }
</style>
</head>
<body>
<div id="status">正在加载OFD渲染器...</div>
<div id="ofd-container"></div>
<script src="https://cdn.jsdelivr.net/npm/ofd.js@latest/dist/ofd.js"></script>
<script>
(async () => {
  try {
    const statusEl = document.getElementById('status');
    const container = document.getElementById('ofd-container');

    if (typeof parseOfdDocument === 'undefined') {
      await new Promise((resolve, reject) => {
        let checks = 0;
        const interval = setInterval(() => {
          checks++;
          if (typeof parseOfdDocument !== 'undefined' || typeof window.ofd !== 'undefined') {
            clearInterval(interval);
            resolve();
          } else if (checks > 50) {
            clearInterval(interval);
            reject(new Error('ofd.js加载超时'));
          }
        }, 200);
      });
    }

    statusEl.textContent = '正在读取OFD文件...';
    const ofdPath = '${ofdFilePath.replace(/'/g, "\\'")}';
    const response = await fetch('file://' + ofdPath);
    const arrayBuffer = await response.arrayBuffer();

    statusEl.textContent = '正在解析OFD文档...';
    const ofdObj = parseOfdDocument(arrayBuffer);
    renderOfd(ofdObj, container);

    statusEl.style.display = 'none';
    document.title = 'OFD_RENDER_COMPLETE';
  } catch (err) {
    document.getElementById('status').textContent = '渲染失败: ' + err.message;
    document.title = 'OFD_RENDER_ERROR';
  }
})();
</script>
</body>
</html>`;

    const htmlTempPath = ofdFilePath.replace(/\.ofd$/i, '_viewer.html');
    fs.writeFileSync(htmlTempPath, ofdHtml, 'utf-8');

    await page.goto(`file://${htmlTempPath}`, {
      waitUntil: 'networkidle0',
      timeout: 60000,
    });

    console.log(`  → 等待OFD渲染...`);
    await page.waitForFunction(
      () => document.title === 'OFD_RENDER_COMPLETE' || document.title === 'OFD_RENDER_ERROR',
      { timeout: 30000 }
    );

    const renderTitle = await page.title();
    if (renderTitle === 'OFD_RENDER_ERROR') {
      throw new Error('ofd.js渲染OFD失败');
    }

    console.log(`  → OFD渲染完成，正在生成PDF...`);
    await page.pdf({ path: outputPath, ...config.pdf, timeout: 120000 });

    if (fs.existsSync(htmlTempPath)) fs.unlinkSync(htmlTempPath);
    return fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000;
  } catch (error) {
    const htmlTempPath = ofdFilePath.replace(/\.ofd$/i, '_viewer.html');
    if (fs.existsSync(htmlTempPath)) fs.unlinkSync(htmlTempPath);
    throw error;
  } finally {
    await page.close();
  }
}

/**
 * 用Puppeteer打开本地HTML文件并生成PDF
 */
async function renderLocalHtml(browser, htmlUrl, outputPath) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ ...config.viewport, height: 1000 });
    await page.goto(htmlUrl, {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });
    await delay(2000);
    await page.pdf({ path: outputPath, ...config.pdf, timeout: 120000 });
    return fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000;
  } finally {
    await page.close();
  }
}

/**
 * 爬取单个页面并生成PDF
 */
async function crawlPage(browser, item, index, total) {
  const { url, title } = item;
  const filename = generatePdfFilename(item);
  const outputPath = path.join(config.outputDir, filename);

  console.log(`\n[${index + 1}/${total}] 正在处理: ${title || url}`);

  const result = {
    url,
    title: title || '',
    filename,
    outputPath,
    success: false,
    fileSize: 0,
    error: null,
  };

  // 检测URL类型，文档类走专属下载转换路径
  const urlType = detectUrlType(url);
  if (urlType === 'pdf') {
    console.log(`  📄 检测到PDF文件，直接下载`);
    try {
      ensureDir(config.outputDir);
      await downloadFile(url, outputPath);
      const stats = fs.statSync(outputPath);
      result.success = true;
      result.fileSize = stats.size;
      console.log(`  ✓ PDF已保存: ${filename} (${formatFileSize(stats.size)})`);
    } catch (error) {
      result.error = error.message;
      console.error(`  ✗ PDF下载失败: ${error.message}`);
    }
    return result;
  }
  if (urlType !== 'html') {
    console.log(`  📄 检测到文档类型: ${urlType.toUpperCase()}`);
    try {
      const pdfPath = await handleDocumentUrl(browser, item, filename);
      const stats = fs.statSync(pdfPath);
      result.success = true;
      result.fileSize = stats.size;
      result.outputPath = pdfPath;
      console.log(`  ✓ PDF已保存: ${path.basename(pdfPath)} (${formatFileSize(result.fileSize)})`);
    } catch (error) {
      result.error = error.message;
      console.error(`  ⚠ ${error.message}`);
    }
    return result;
  }

  // 网页类URL：使用Puppeteer渲染生成PDF
  const page = await browser.newPage();

  try {
    // 1. 设置标准宽屏视口，避免政府网站浮动（float）掉块错位
    await page.setUserAgent(config.userAgent);
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });

    // 拦截不必要的音视频请求
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const resourceType = request.resourceType();
      if (['media'].includes(resourceType)) {
        request.abort();
      } else {
        request.continue();
      }
    });

    console.log(`  → 正在加载页面...`);
    await page.goto(url, {
      waitUntil: config.page.waitUntil || 'networkidle2',
      timeout: config.page.longTimeout || 120000,
    });

    await delay(config.page.extraWait || 1500);

    // 尝试等待主要内容区域加载
    try {
      await page.waitForSelector(
        '.article-content, .content, #content, .TRS_Editor, .Custom_UnionStyle, .pages_content, main, article',
        { timeout: 10000 }
      );
    } catch {
      console.log(`  ⚠ 未匹配到常见内容选择器，使用当前页面内容`);
    }

    if (!title) {
      const pageTitle = await page.title();
      result.title = pageTitle || '';
    }

    // 移除指定的垃圾节点（如多余广告、悬浮框等）
    if (config.removeSelectors && config.removeSelectors.length > 0) {
      const removedCount = await page.evaluate((selectors) => {
        let count = 0;
        for (const selector of selectors) {
          const elements = document.querySelectorAll(selector);
          elements.forEach((el) => {
            el.remove();
            count++;
          });
        }
        return count;
      }, config.removeSelectors);
      if (removedCount > 0) {
        console.log(`  → 已移除 ${removedCount} 个非内容元素`);
      }
    }

    // 2. 关键修复：模拟屏幕媒体（screen），所见即所得，防止原网站自带的 @media print 弄乱排版
    await page.emulateMediaType('screen');
    await delay(300);

    // 3. 关键修复：精准注入打印样式（只解除正文容器限制，绝不污染外层 div 和头尾）
    await page.addStyleTag({
      content: `
        /* 解除正文及常见包装容器的不可拆分限制，解决大面积空白跳页 */
        .sj_arc_body, .sj_er_kuang_xiang, .article-content, 
        .TRS_Editor, .Custom_UnionStyle, .pages_content, 
        #content, .content, .main_content, .arc_body, article, main {
          overflow: visible !important;
          overflow-x: visible !important;
          overflow-y: visible !important;
          height: auto !important;
          max-height: none !important;
          min-height: 0 !important;
          page-break-inside: auto !important;
          break-inside: auto !important;
        }

        /* 标题后不换页，段落必须允许正常分页，解除连锁换页空白 */
        h1, h2, h3, h4, h5, h6 {
          page-break-after: avoid !important;
          break-after: avoid-page !important;
        }
        p {
          page-break-after: auto !important;
          break-after: auto !important;
          page-break-inside: auto !important;
          break-inside: auto !important;
          orphans: 1 !important;
          widows: 1 !important;
        }

        /* 表格分页优化：整表允许跨页，单行 tr 不被截断 */
        table {
          page-break-inside: auto !important;
          break-inside: auto !important;
        }
        tr {
          page-break-inside: avoid !important;
          break-inside: avoid !important;
        }
        td, th {
          page-break-inside: auto !important;
          break-inside: auto !important;
        }
      `,
    });

    // 移除文章中自带强制换页样式的多余换行符
    await page.evaluate(() => {
      document.querySelectorAll('br').forEach((br) => {
        const s = window.getComputedStyle(br);
        if (
          s.pageBreakBefore === 'always' ||
          s.pageBreakBefore === 'left' ||
          s.pageBreakBefore === 'right'
        ) {
          br.remove();
        }
      });
    });

    ensureDir(config.outputDir);

    // 4. 导出 PDF：结合桌面视口等比缩放至 A4，保证页面宽度完整容纳且不溢出
    console.log(`  → 正在生成PDF...`);
    await page.pdf({
      path: outputPath,
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: false,
      margin: {
        top: '12mm',
        bottom: '12mm',
        left: '12mm',
        right: '12mm',
      },
      scale: 0.8, // 1280px 宽度等比缩小放入 A4 的黄金比例
      timeout: 120000,
    });

    if (fs.existsSync(outputPath)) {
      const stats = fs.statSync(outputPath);
      result.success = true;
      result.fileSize = stats.size;
      console.log(`  ✓ PDF已保存: ${filename} (${formatFileSize(result.fileSize)})`);
    } else {
      throw new Error('PDF文件未生成');
    }
  } catch (error) {
    result.error = error.message;
    console.error(`  ✗ 失败: ${error.message}`);
  } finally {
    await page.close();
  }

  return result;
}

/**
 * 主爬取流程
 */
async function crawl(urlList) {
  console.log('='.repeat(60));
  console.log('网页PDF快照爬取工具');
  console.log('='.repeat(60));
  console.log(`共 ${urlList.length} 个页面待处理\n`);

  ensureDir(config.outputDir);

  console.log('正在启动浏览器...');
  const browser = await puppeteer.launch(config.browser);
  console.log('浏览器已启动\n');

  const results = [];

  try {
    for (let i = 0; i < urlList.length; i += config.concurrency) {
      const batch = urlList.slice(i, i + config.concurrency);
      const batchPromises = batch.map((item, batchIndex) =>
        withRetry(
          () => crawlPage(browser, item, i + batchIndex, urlList.length),
          config.retry,
          item.title ? item.title.slice(0, 20) : item.url
        )
      );

      const batchResults = await Promise.allSettled(batchPromises);

      for (const settled of batchResults) {
        if (settled.status === 'fulfilled') {
          results.push(settled.value);
        } else {
          results.push({
            success: false,
            error: settled.reason?.message || '未知错误',
          });
        }
      }
    }
  } finally {
    await browser.close();
    console.log('\n浏览器已关闭');
  }

  return results;
}

module.exports = { crawl, crawlPage };