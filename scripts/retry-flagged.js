/**
 * 重新爬取预览器中标记有问题的 PDF
 * 读取 output/_flags.json，匹配回 urls.json 中的 URL，重新爬取到 output/pdfs/
 * 用法: node scripts/retry-flagged.js
 */
const fs = require('fs');
const path = require('path');
const { crawl } = require('../src/crawler');
const { generatePdfFilename } = require('../src/utils');
const config = require('../config');

const FLAGS_PATH = path.join(config.outputDir, '_flags.json');
const URLS_PATH = path.join(__dirname, '..', 'urls.json');
// 重试输出目录：output/pdfs
const RETRY_DIR = path.join(config.outputDir, 'pdfs');

async function main() {
  // 读取标记数据
  if (!fs.existsSync(FLAGS_PATH)) {
    console.error('错误: 未找到标记文件 output/_flags.json');
    console.error('请先在预览器中标记有问题的 PDF');
    process.exit(1);
  }

  const flags = JSON.parse(fs.readFileSync(FLAGS_PATH, 'utf-8'));
  if (flags.length === 0) {
    console.log('标记列表为空，无需重试');
    process.exit(0);
  }

  console.log(`读取到 ${flags.length} 条标记：`);
  flags.forEach((f, i) => {
    console.log(`  ${i + 1}. [${f.type}] ${f.filename}`);
    if (f.note) console.log(`     备注: ${f.note}`);
  });

  // 读取 URL 列表
  const urlList = JSON.parse(fs.readFileSync(URLS_PATH, 'utf-8'));

  // 将标记的文件名匹配回 URL
  const flaggedFilenames = new Set(flags.map((f) => f.filename));
  const matchedItems = [];
  const unmatchedFilenames = [];

  for (const item of urlList) {
    const filename = generatePdfFilename(item);
    if (flaggedFilenames.has(filename)) {
      matchedItems.push(item);
      flaggedFilenames.delete(filename);
    }
  }

  // 检查未匹配的文件名
  for (const fname of flaggedFilenames) {
    unmatchedFilenames.push(fname);
  }

  if (unmatchedFilenames.length > 0) {
    console.log(`\n⚠ 以下 ${unmatchedFilenames.length} 个标记文件名未在 urls.json 中找到匹配：`);
    unmatchedFilenames.forEach((f) => console.log(`  - ${f}`));
  }

  if (matchedItems.length === 0) {
    console.log('\n没有可重试的项目');
    process.exit(0);
  }

  console.log(`\n匹配到 ${matchedItems.length} 个 URL，准备重新爬取到 output/pdfs/：`);
  matchedItems.forEach((item, i) => {
    console.log(`  ${i + 1}. ${item.title || item.url}`);
  });

  // 删除 output/pdfs/ 下的旧文件
  if (!fs.existsSync(RETRY_DIR)) {
    fs.mkdirSync(RETRY_DIR, { recursive: true });
  }
  for (const item of matchedItems) {
    const filename = generatePdfFilename(item);
    const oldPath = path.join(RETRY_DIR, filename);
    if (fs.existsSync(oldPath)) {
      fs.unlinkSync(oldPath);
      console.log(`  已删除旧文件: ${filename}`);
    }
  }

  // 临时将输出目录切换到 output/pdfs/
  const originalOutputDir = config.outputDir;
  config.outputDir = RETRY_DIR;

  // 调用主爬取流程
  console.log('\n开始重新爬取...\n');
  const results = await crawl(matchedItems);

  // 恢复原始输出目录
  config.outputDir = originalOutputDir;

  // 输出结果
  const successCount = results.filter((r) => r.success).length;
  console.log('\n' + '='.repeat(50));
  console.log(`重试完成: ${successCount}/${matchedItems.length} 个成功`);
  console.log(`文件保存在: ${RETRY_DIR}`);

  if (successCount === matchedItems.length) {
    console.log('\n全部重试成功，如需清空标记，运行:');
    console.log('  echo "[]" > output/_flags.json');
  }

  // 保存重试报告
  const reportPath = path.join(RETRY_DIR, '_retry-report.json');
  const report = {
    timestamp: new Date().toISOString(),
    retried: matchedItems.length,
    success: successCount,
    results,
    originalFlags: flags,
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`重试报告已保存: ${reportPath}`);
}

main().catch((err) => {
  console.error('重试过程中发生错误:', err.message);
  process.exit(1);
});