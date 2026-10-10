/**
 * 一次性脚本：下载 urls.json 中的 PDF 原始文件到 output/pdfs/
 * 使用与主程序相同的命名格式：日期_标题.pdf
 * 用法: node scripts/download-pdfs.js
 * 运行完成后可删除此脚本
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const OUTPUT_DIR = path.join(__dirname, '..', 'output', 'pdfs');
const URLS_PATH = path.join(__dirname, '..', 'urls.json');

/**
 * 清理文件名中的非法字符（与主程序 utils.js 保持一致）
 */
function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    .trim();
}

/**
 * 根据URL和标题生成PDF文件名（与主程序 utils.js 保持一致）
 */
function generatePdfFilename(item) {
  const { url, title } = item;
  const dateMatch = url.match(/(\d{6})\//);
  const datePrefix = dateMatch ? dateMatch[1] : new Date().toISOString().slice(0, 7).replace('-', '');

  if (title) {
    const shortTitle = title.length > 60 ? title.slice(0, 60) : title;
    return `${datePrefix}_${sanitizeFilename(shortTitle)}.pdf`;
  }

  const idMatch = url.match(/t\d+_(\d+)\.htm/);
  const id = idMatch ? idMatch[1] : Date.now();
  return `${datePrefix}_${id}.pdf`;
}

/**
 * 下载文件（支持重定向）
 */
function downloadFile(url, outputPath, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      reject(new Error('重定向次数过多'));
      return;
    }
    const protocol = url.startsWith('https') ? https : http;
    const request = protocol.get(url, { timeout: 60000 }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        let redirectUrl = response.headers.location;
        if (!redirectUrl.startsWith('http')) {
          const parsed = new URL(url);
          redirectUrl = `${parsed.protocol}//${parsed.host}${redirectUrl}`;
        }
        downloadFile(redirectUrl, outputPath, maxRedirects - 1).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      const file = fs.createWriteStream(outputPath);
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(outputPath);
      });
      file.on('error', reject);
    });
    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('下载超时'));
    });
  });
}

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const urlList = JSON.parse(fs.readFileSync(URLS_PATH, 'utf-8'));
  const pdfItems = urlList.filter((item) => {
    const urlPath = item.url.split('?')[0].split('#')[0];
    const ext = urlPath.split('.').pop().toLowerCase();
    return ext === 'pdf';
  });

  console.log(`找到 ${pdfItems.length} 个 PDF URL，开始下载到 output/pdfs/\n`);
  console.log('命名格式与主程序一致：日期_标题.pdf\n');

  const results = [];

  for (let i = 0; i < pdfItems.length; i++) {
    const item = pdfItems[i];
    // 使用与主程序相同的命名逻辑
    const filename = generatePdfFilename(item);
    const outputPath = path.join(OUTPUT_DIR, filename);

    console.log(`[${i + 1}/${pdfItems.length}] ${item.title}`);
    console.log(`  URL: ${item.url}`);
    console.log(`  文件名: ${filename}`);

    try {
      await downloadFile(item.url, outputPath);
      const stats = fs.statSync(outputPath);
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
      console.log(`  ✓ 已下载 (${sizeMB} MB)\n`);

      results.push({
        url: item.url,
        title: item.title,
        filename,
        sizeMB: +sizeMB,
        success: true,
      });
    } catch (error) {
      console.error(`  ✗ 下载失败: ${error.message}\n`);
      results.push({
        url: item.url,
        title: item.title,
        filename,
        success: false,
        error: error.message,
      });
    }
  }

  // 保存下载报告
  const reportPath = path.join(OUTPUT_DIR, '_download-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2), 'utf-8');

  const successCount = results.filter((r) => r.success).length;
  console.log('='.repeat(50));
  console.log(`完成: ${successCount}/${pdfItems.length} 个下载成功`);
  console.log(`文件保存在: ${OUTPUT_DIR}`);
  console.log(`下载报告: ${reportPath}`);
}

main().catch(console.error);
