const fs = require('fs');
const path = require('path');
const { crawl } = require('./src/crawler');
const config = require('./config');

/**
 * 生成爬取报告
 * @param {Array} results - 爬取结果列表
 */
function generateReport(results) {
  const successCount = results.filter((r) => r.success).length;
  const failCount = results.length - successCount;
  const totalSize = results.reduce((sum, r) => sum + (r.fileSize || 0), 0);

  console.log('\n' + '='.repeat(60));
  console.log('爬取报告');
  console.log('='.repeat(60));
  console.log(`总计: ${results.length} 个页面`);
  console.log(`成功: ${successCount} 个`);
  console.log(`失败: ${failCount} 个`);
  console.log(`总大小: ${(totalSize / (1024 * 1024)).toFixed(2)} MB`);
  console.log(`输出目录: ${config.outputDir}`);

  if (failCount > 0) {
    console.log('\n失败列表:');
    results
      .filter((r) => !r.success)
      .forEach((r) => {
        console.log(`  - ${r.url || '未知URL'}: ${r.error}`);
      });
  }

  // 将报告保存为JSON
  const reportPath = path.join(config.outputDir, 'report.json');
  const report = {
    timestamp: new Date().toISOString(),
    total: results.length,
    success: successCount,
    failed: failCount,
    totalSizeMB: +(totalSize / (1024 * 1024)).toFixed(2),
    items: results,
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`\n报告已保存: ${reportPath}`);
}

/**
 * 主函数
 */
async function main() {
  // 读取URL列表
  const urlsPath = path.join(__dirname, 'urls.json');

  if (!fs.existsSync(urlsPath)) {
    console.error('错误: urls.json 文件不存在');
    console.error('请创建 urls.json 文件，格式如下:');
    console.error(JSON.stringify([{ url: 'https://example.com', title: '示例页面' }], null, 2));
    process.exit(1);
  }

  const urlList = JSON.parse(fs.readFileSync(urlsPath, 'utf-8'));

  if (!Array.isArray(urlList) || urlList.length === 0) {
    console.error('错误: urls.json 为空或格式不正确');
    process.exit(1);
  }

  // 支持 --limit 参数限制爬取数量（用于测试），兼容 --limit=1 和 --limit 1
  const limitIndex = process.argv.indexOf('--limit');
  let limit;
  if (limitIndex !== -1 && process.argv[limitIndex + 1]) {
    limit = parseInt(process.argv[limitIndex + 1], 10);
  } else {
    const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
    if (limitArg) limit = parseInt(limitArg.split('=')[1], 10);
  }
  if (limit && limit > 0) {
    urlList.splice(limit);
    console.log(`限制模式: 仅爬取前 ${limit} 个页面`);
  }

  // 支持 --retry-failed 参数：仅重试上次失败的URL
  if (process.argv.includes('--retry-failed')) {
    const reportPath = path.join(config.outputDir, 'report.json');
    if (!fs.existsSync(reportPath)) {
      console.error('错误: 未找到上次爬取报告 report.json，无法重试失败项');
      process.exit(1);
    }
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    const failedItems = report.items.filter((item) => !item.success);
    if (failedItems.length === 0) {
      console.log('上次爬取全部成功，无需重试');
      process.exit(0);
    }
    console.log(`重试模式: 从上次报告中提取 ${failedItems.length} 个失败项`);
    urlList.length = 0;
    failedItems.forEach((item) => {
      urlList.push({ url: item.url, title: item.title || '' });
    });
  }

  // 支持通过命令行传入单个URL
  const cmdUrl = process.argv.find((arg) => arg.startsWith('http'));
  if (cmdUrl) {
    urlList.length = 0;
    urlList.push({ url: cmdUrl, title: '' });
  }

  try {
    const results = await crawl(urlList);
    generateReport(results);
  } catch (error) {
    console.error('爬取过程中发生致命错误:', error.message);
    process.exit(1);
  }
}

main();