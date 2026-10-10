const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const OUTPUT_DIR = path.join(__dirname, '..', 'output', 'pdfs');

const ITEMS = [
  {
    url: 'https://xmsyj.moa.gov.cn/gzdt/202302/P020230222603217696835.pdf',
    title: '全国布鲁氏菌病免疫县名单 1. 北京市〔附件〕',
  },
  {
    url: 'https://xmsyj.moa.gov.cn/gzdt/202302/P020240408417564517618.pdf',
    title: '全国布鲁氏菌病免疫县名单 1. 北京市〔附件〕',
  },
];

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    .trim();
}

function generateUniquePdfFilename(item) {
  const { url, title } = item;
  const dateMatch = url.match(/(\d{6})\//);
  const datePrefix = dateMatch ? dateMatch[1] : new Date().toISOString().slice(0, 7).replace('-', '');
  const idMatch = url.match(/\/(P\d+)\.pdf/i);
  const urlId = idMatch ? idMatch[1] : Date.now();
  const shortTitle = title && title.length > 60 ? title.slice(0, 60) : (title || '');
  const titlePart = shortTitle ? `_${sanitizeFilename(shortTitle)}` : '';
  return `${datePrefix}_${urlId}${titlePart}.pdf`;
}

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

  for (let i = 0; i < ITEMS.length; i++) {
    const item = ITEMS[i];
    const filename = generateUniquePdfFilename(item);
    const outputPath = path.join(OUTPUT_DIR, filename);

    console.log(`[${i + 1}/${ITEMS.length}] ${item.title}`);
    console.log(`  URL: ${item.url}`);
    console.log(`  文件名: ${filename}`);

    try {
      await downloadFile(item.url, outputPath);
      const stats = fs.statSync(outputPath);
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
      console.log(`  ✓ 已下载 (${sizeMB} MB)\n`);
    } catch (error) {
      console.error(`  ✗ 下载失败: ${error.message}\n`);
    }
  }

  console.log('下载完成，文件保存在:', OUTPUT_DIR);
}

main().catch(console.error);