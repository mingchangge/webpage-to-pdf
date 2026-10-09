const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execFile } = require('child_process');

/**
 * 清理文件名中的非法字符
 * @param {string} name - 原始名称
 * @returns {string} 安全的文件名
 */
function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    .trim();
}

/**
 * 根据URL和标题生成有意义的PDF文件名
 * @param {object} item - 包含 url 和 title 的对象
 * @returns {string} PDF文件名
 */
function generatePdfFilename(item) {
  const { url, title } = item;
  const dateMatch = url.match(/(\d{6})\//);
  const datePrefix = dateMatch ? dateMatch[1] : new Date().toISOString().slice(0, 7).replace('-', '');

  if (title) {
    const shortTitle = title.length > 60 ? title.slice(0, 60) : title;
    return `${datePrefix}_${sanitizeFilename(shortTitle)}.pdf`;
  }

  // 无标题时从URL提取ID
  const idMatch = url.match(/t\d+_(\d+)\.htm/);
  const id = idMatch ? idMatch[1] : Date.now();
  return `${datePrefix}_${id}.pdf`;
}

/**
 * 确保目录存在
 * @param {string} dirPath - 目录路径
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * 延迟指定毫秒
 * @param {number} ms - 延迟时间
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 带重试的异步操作
 * @param {Function} fn - 异步函数
 * @param {object} retryConfig - 重试配置
 * @param {string} label - 操作标签（用于日志）
 * @returns {Promise<*>} 函数执行结果
 */
async function withRetry(fn, retryConfig, label = '') {
  const { maxAttempts, delayMs } = retryConfig;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt === maxAttempts;
      const prefix = label ? `[${label}]` : '';

      if (isLastAttempt) {
        console.error(`${prefix} 第${attempt}次尝试失败，已达最大重试次数`);
      } else {
        console.warn(`${prefix} 第${attempt}次尝试失败，${delayMs / 1000}秒后重试...`);
        await delay(delayMs);
      }
    }
  }

  throw lastError;
}

/**
 * 格式化文件大小
 * @param {number} bytes - 字节数
 * @returns {string} 格式化后的大小
 */
function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 检测URL指向的资源类型
 * @param {string} url - URL地址
 * @returns {string} 类型: 'pdf' | 'doc' | 'docx' | 'xls' | 'xlsx' | 'ppt' | 'pptx' | 'ofd' | 'image' | 'html'
 */
function detectUrlType(url) {
  const urlPath = url.split('?')[0].split('#')[0];
  const ext = urlPath.split('.').pop().toLowerCase();
  const docMap = {
    pdf: 'pdf', doc: 'doc', docx: 'docx',
    xls: 'xls', xlsx: 'xlsx',
    ppt: 'ppt', pptx: 'pptx',
    ofd: 'ofd', rtf: 'rtf', wps: 'wps',
  };
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg'];
  if (docMap[ext]) return docMap[ext];
  if (imageExts.includes(ext)) return 'image';
  return 'html';
}

/**
 * 下载文件到本地（支持重定向）
 * @param {string} url - 文件URL
 * @param {string} outputPath - 本地保存路径
 * @param {number} maxRedirects - 最大重定向次数
 * @returns {Promise<string>} 保存的文件路径
 */
function downloadFile(url, outputPath, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      reject(new Error('重定向次数过多'));
      return;
    }
    const protocol = url.startsWith('https') ? https : http;
    const request = protocol.get(url, { timeout: 30000 }, (response) => {
      // 处理重定向
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

/**
 * 使用 LibreOffice 将文档转换为 HTML
 * 转HTML而非PDF，因为HTML保留文本内容，后续由Chrome渲染不会乱码
 * @param {string} inputPath - 输入文件路径
 * @param {string} outputDir - 输出目录
 * @param {string} libreofficePath - LibreOffice 可执行文件路径
 * @returns {Promise<string>} 生成的HTML路径
 */
function convertToHtml(inputPath, outputDir, libreofficePath = 'libreoffice') {
  return new Promise((resolve, reject) => {
    execFile(
      libreofficePath,
      ['--headless', '--convert-to', 'html', '--outdir', outputDir, inputPath],
      { timeout: 60000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`LibreOffice转HTML失败: ${error.message}`));
          return;
        }
        const htmlName = path.basename(inputPath, path.extname(inputPath)) + '.html';
        const htmlPath = path.join(outputDir, htmlName);
        if (fs.existsSync(htmlPath)) {
          resolve(htmlPath);
        } else {
          reject(new Error('转换后HTML文件未找到'));
        }
      }
    );
  });
}

module.exports = {
  sanitizeFilename,
  generatePdfFilename,
  ensureDir,
  delay,
  withRetry,
  formatFileSize,
  detectUrlType,
  downloadFile,
  convertToHtml,
};