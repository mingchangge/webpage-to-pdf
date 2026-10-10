const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const config = require('../config');
const { generatePdfFilename, ensureDir, delay, withRetry, formatFileSize, detectUrlType, downloadFile, convertToHtml } = require('./utils');

/**
 * 爬取单个页面并生成PDF
 * @param {import('puppeteer').Browser} browser - Puppeteer浏览器实例
 * @param {object} item - URL项 { url, title, domain_name }
 * @param {number} index - 当前序号
 * @param {number} total - 总数
 * @returns {object} 结果信息
 */
/**
 * 处理文档类URL（.doc, .docx, .xls, .xlsx, .ppt, .pptx, .ofd, .pdf等）
 * 核心策略：下载文件 → LibreOffice转HTML → Puppeteer渲染HTML生成PDF
 * 这样中文由Chrome渲染，彻底解决LibreOffice直接转PDF的乱码问题
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
    // 策略1：LibreOffice转HTML + Puppeteer渲染PDF（最佳方案，中文不乱码）
    console.log(`  → 正在通过LibreOffice转HTML...`);
    try {
      const htmlPath = await convertToHtml(tempPath, downloadDir, config.libreofficePath);
      console.log(`  ✓ 已转HTML: ${path.basename(htmlPath)}`);

      // 用Puppeteer打开本地HTML并生成PDF
      console.log(`  → 正在渲染HTML生成PDF...`);
      const htmlUrl = `file://${htmlPath}`;
      const pdfResult = await renderLocalHtml(browser, htmlUrl, outputPath);

      // 清理临时文件
      fs.unlinkSync(tempPath);
      if (fs.existsSync(htmlPath)) fs.unlinkSync(htmlPath);

      if (pdfResult) return outputPath;
      throw new Error('HTML渲染PDF失败');
    } catch (htmlError) {
      console.log(`  ⚠ LibreOffice转HTML失败: ${htmlError.message}`);
    }

    // 策略2：在线查看器（备选，需公网可访问）
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

    // 策略3：下载原文件保底
    const origOutput = outputPath.replace(/\.pdf$/, `.${urlType}`);
    if (!fs.existsSync(origOutput)) {
      fs.copyFileSync(tempPath, origOutput);
    }
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    throw new Error(`所有转换策略失败，已保存原文件: ${path.basename(origOutput)}`);
  }

  // 其他未知类型，保留原文件
  const rawOutput = outputPath.replace(/\.pdf$/, `.${urlType}`);
  fs.copyFileSync(tempPath, rawOutput);
  fs.unlinkSync(tempPath);
  throw new Error(`不支持的格式 .${urlType}，已保存原文件: ${path.basename(rawOutput)}`);
}

/**
 * 用ofd.js在浏览器中渲染OFD文件，再生成PDF
 * ofd.js是纯前端OFD渲染库，将OFD解析为SVG/Canvas显示在页面上
 * 然后用Puppeteer的page.pdf()捕获为PDF
 */
async function renderOfdInBrowser(browser, ofdFilePath, outputPath) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ ...config.viewport, height: 1200 });

    // 构造一个自包含的HTML页面，内嵌ofd.js渲染逻辑
    // ofd.js的CDN地址（基于DLTech21/ofd.js项目）
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

    // 等待ofd.js加载完成
    if (typeof parseOfdDocument === 'undefined') {
      // 尝试从window中查找ofd.js导出的函数
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

    // 通过Puppeteer注入的文件路径读取OFD
    // 这里使用fetch读取本地文件（通过file://协议）
    const ofdPath = '${ofdFilePath.replace(/'/g, "\\'")}';
    const response = await fetch('file://' + ofdPath);
    const arrayBuffer = await response.arrayBuffer();

    statusEl.textContent = '正在解析OFD文档...';

    // 调用ofd.js解析和渲染
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

    // 将HTML写入临时文件
    const htmlTempPath = ofdFilePath.replace(/\.ofd$/i, '_viewer.html');
    fs.writeFileSync(htmlTempPath, ofdHtml, 'utf-8');

    await page.goto(`file://${htmlTempPath}`, {
      waitUntil: 'networkidle0',
      timeout: 60000,
    });

    // 等待渲染完成（通过document.title判断）
    console.log(`  → 等待OFD渲染...`);
    await page.waitForFunction(
      () => document.title === 'OFD_RENDER_COMPLETE' || document.title === 'OFD_RENDER_ERROR',
      { timeout: 30000 }
    );

    const renderTitle = await page.title();
    if (renderTitle === 'OFD_RENDER_ERROR') {
      throw new Error('ofd.js渲染OFD失败');
    }

    // 渲染成功，生成PDF
    console.log(`  → OFD渲染完成，正在生成PDF...`);
    await page.pdf({ path: outputPath, ...config.pdf, timeout: 120000 });

    // 清理临时HTML
    if (fs.existsSync(htmlTempPath)) fs.unlinkSync(htmlTempPath);

    return fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000;
  } catch (error) {
    // 清理临时文件
    const htmlTempPath = ofdFilePath.replace(/\.ofd$/i, '_viewer.html');
    if (fs.existsSync(htmlTempPath)) fs.unlinkSync(htmlTempPath);
    throw error;
  } finally {
    await page.close();
  }
}

/**
 * 用Puppeteer打开本地HTML文件并生成PDF
 * Chrome渲染中文不会乱码，这是解决乱码的关键
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

async function crawlPage(browser, item, index, total) {
  const { url, title } = item;
  const label = title ? title.slice(0, 30) : url;
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

  // 检测URL类型，文档类走下载+转换路径
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
      // 部分错误下文件已保存（如OFD），标记为部分成功
      result.error = error.message;
      console.error(`  ⚠ ${error.message}`);
    }
    return result;
  }

  // 网页类URL：使用Puppeteer渲染并生成PDF
  const page = await browser.newPage();

  try {
    // 设置User-Agent和视口
    await page.setUserAgent(config.userAgent);
    await page.setViewport(config.viewport);

    // 拦截不必要的资源请求（加快加载速度，但保留字体和样式）
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const resourceType = request.resourceType();
      if (['media'].includes(resourceType)) {
        request.abort();
      } else {
        request.continue();
      }
    });

    // 导航到目标页面（使用更长的超时时间应对慢速页面）
    console.log(`  → 正在加载页面...`);
    await page.goto(url, {
      waitUntil: config.page.waitUntil,
      timeout: config.page.longTimeout || 120000,
    });

    // 额外等待，确保动态内容渲染完成
    await delay(config.page.extraWait);

    // 尝试等待主要内容区域加载
    try {
      await page.waitForSelector(
        '.article-content, .content, #content, .TRS_Editor, .Custom_UnionStyle, .pages_content, main, article',
        { timeout: 10000 }
      );
    } catch {
      console.log(`  ⚠ 未匹配到常见内容选择器，使用当前页面内容`);
    }

    // 获取页面实际标题（如果未提供）
    if (!title) {
      const pageTitle = await page.title();
      result.title = pageTitle || '';
    }

    // 移除页面非内容元素（头部、导航、页脚等）
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
    }, config.removeSelectors || []);
    if (removedCount > 0) {
      console.log(`  → 已移除 ${removedCount} 个非内容元素`);
    }
    // 生成PDF前：切换到打印视口宽度，让布局按打印尺寸排列
    // A4纸宽210mm - 左右边距30mm = 180mm ≈ 680px@96DPI
    const printViewportWidth = 680;
    await page.setViewport({ ...config.viewport, width: printViewportWidth });
    await delay(500);

    // 滚动到顶部，确保文档坐标计算正确
    await page.evaluate(() => window.scrollTo(0, 0));
    await delay(300);
    // 紧凑布局：当内容距顶部过远时，压缩中间间距（保留头部，只挤间距）
    if (config.compactLayout) {
      const compactResult = await page.evaluate((cfg) => {
        const { contentSelectors, compactThreshold } = cfg;

        // 查找主要内容 div
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

        // 使用文档坐标（rect.top + scrollY），不受滚动位置影响
        const rect = contentEl.getBoundingClientRect();
        const contentTop = rect.top + window.scrollY;

        // 偏移不够大，不需要处理
        if (contentTop < compactThreshold) {
          return { found: true, selector: matchedSelector, offsetTop: Math.round(contentTop), compacted: false };
        }

        // 策略：从内容div向上遍历，逐层压缩margin/padding
        // 1. 内容div自身的marginTop清零
        contentEl.style.marginTop = '0';
        contentEl.style.paddingTop = '0';

        // 2. 向上遍历父元素，压缩中间容器的间距
        let parent = contentEl.parentElement;
        while (parent && parent !== document.body) {
          const style = getComputedStyle(parent);
          // 如果这个父元素的marginTop/paddingTop过大，压缩它
          if (parseFloat(style.marginTop) > 10) parent.style.marginTop = '0';
          if (parseFloat(style.paddingTop) > 10) parent.style.paddingTop = '0';
          parent = parent.parentElement;
        }

        // 3. 找到内容div在body中的最外层容器，压缩它上方兄弟元素的间距
        let container = contentEl;
        while (container.parentElement && container.parentElement !== document.body) {
          container = container.parentElement;
        }
        // 遍历容器之前的兄弟元素（头部区域），压缩它们的底部间距
        let sibling = container.previousElementSibling;
        while (sibling) {
          const style = getComputedStyle(sibling);
          if (parseFloat(style.marginBottom) > 10) sibling.style.marginBottom = '0';
          if (parseFloat(style.paddingBottom) > 10) sibling.style.paddingBottom = '0';
          // 如果兄弟元素高度过大（>200px且不是主要内容），限制其高度
          if (sibling.offsetHeight > 200 && !sibling.querySelector(contentSelectors.join(','))) {
            sibling.style.height = 'auto';
            sibling.style.minHeight = '0';
            sibling.style.overflow = 'visible';
          }
          sibling = sibling.previousElementSibling;
        }

        // 4. 压缩容器自身的顶部间距
        container.style.marginTop = '0';
        container.style.paddingTop = '0';

        const newRect = contentEl.getBoundingClientRect();
        const newTop = newRect.top + window.scrollY;
        return {
          found: true,
          selector: matchedSelector,
          offsetTop: Math.round(contentTop),
          newOffsetTop: Math.round(newTop),
          compacted: true,
          saved: Math.round(contentTop - newTop),
        };
      }, config.compactLayout);

      if (compactResult.found) {
        if (compactResult.compacted) {
          console.log(`  → 紧凑布局: ${compactResult.selector} 偏移 ${compactResult.offsetTop}px → ${compactResult.newOffsetTop}px（节省 ${compactResult.saved}px）`);
        } else {
          console.log(`  → 内容偏移 ${compactResult.offsetTop}px，无需紧凑处理`);
        }
      }
    }
    // 注入打印分页修复CSS：允许内容区域内分页，防止整块被推到下一页
    await page.addStyleTag({
      content: `
        .sj_arc_body, .sj_arc_body *,
        .sj_er_kuang_xiang, .sj_er_kuang_xiang *,
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
        br,
        .sj_arc_body br,
        .sj_er_kuang_xiang br,
        .article-content br,
        .TRS_Editor br,
        .Custom_UnionStyle br,
        .pages_content br,
        #content br,
        .content br,
        article br,
        main br {
          page-break-before: auto !important;
          page-break-after: auto !important;
          break-before: auto !important;
          break-after: auto !important;
        }
      `,
    });
    // 移除内容区域内带有 page-break-before:always 的 <br> 元素
    const removedBrCount = await page.evaluate(() => {
      const sels = [
        '.sj_arc_body', '.article-content', '.TRS_Editor',
        '.Custom_UnionStyle', '.pages_content', '#content',
        '.content', 'article', 'main',
      ];
      let count = 0;
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (!el) continue;
        el.querySelectorAll('br').forEach((br) => {
          const s = getComputedStyle(br);
          if (
            s.pageBreakBefore === 'always' ||
            s.pageBreakBefore === 'left' ||
            s.pageBreakBefore === 'right'
          ) {
            br.remove();
            count++;
          }
        });
      }
      return count;
    });
    if (removedBrCount > 0) {
      console.log(`  → 已移除 ${removedBrCount} 个强制分页的 <br> 元素`);
    }
    // 确保输出目录存在
    ensureDir(config.outputDir);

    // 生成PDF
    console.log(`  → 正在生成PDF...`);
    await page.pdf({
      path: outputPath,
      ...config.pdf,
      timeout: 120000,
    });

    // 检查文件是否生成成功
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
 * @param {Array} urlList - URL列表
 * @returns {Promise<Array>} 结果列表
 */
async function crawl(urlList) {
  console.log('='.repeat(60));
  console.log('网页PDF快照爬取工具');
  console.log('='.repeat(60));
  console.log(`共 ${urlList.length} 个页面待处理\n`);

  ensureDir(config.outputDir);

  // 启动浏览器
  console.log('正在启动浏览器...');
  const browser = await puppeteer.launch(config.browser);
  console.log('浏览器已启动\n');

  const results = [];

  try {
    // 按并发数分批处理
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