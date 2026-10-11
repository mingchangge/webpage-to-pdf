const path = require('path');

module.exports = {
  // 输出目录
  outputDir: path.join(__dirname, 'output/pdfs/'),

  // Puppeteer 启动配置
  browser: {
    headless: process.env.HEADLESS !== 'false',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--lang=zh-CN',
    ],
  },

  // 页面导航配置
  page: {
    // 默认超时时间（毫秒）
    timeout: 60000,
    // 慢速页面超时时间（毫秒）
    longTimeout: 120000,
    // 等待网络空闲
    waitUntil: 'networkidle2',
    // 页面加载后额外等待时间（确保动态内容渲染完成）
    extraWait: 3000,
  },

  // PDF 生成配置
  pdf: {
    format: 'A4',
    printBackground: true,
    margin: {
      top: '20mm',
      bottom: '20mm',
      left: '15mm',
      right: '15mm',
    },
    // 是否使用打印媒体样式（通常更干净）
    preferCSSPageSize: false,
  },

  // 视口配置（影响PDF页面宽度）
  viewport: {
    width: 1280,
    height: 800,
  },

  // 反爬虫：User-Agent
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',

  // 重试配置
  retry: {
    maxAttempts: 3,
    delayMs: 5000,
  },

  // 并发数
  concurrency: 2,

  // LibreOffice 可执行文件路径（用于转换 doc/docx/xls/xlsx/ppt 为 PDF）
  // macOS: 安装后通常为 '/Applications/LibreOffice.app/Contents/MacOS/soffice'
  // Linux: 通常为 'libreoffice'
  // 如果未安装，doc等文件将只下载不转换
  libreofficePath: '/Applications/LibreOffice.app/Contents/MacOS/soffice',

  // 生成PDF前需要移除的DOM元素选择器（按优先级排列，匹配到即移除）
  // 这些选择器覆盖了常见政府网站的头部、导航、页脚等非内容区域
  removeSelectors: [
    // 顶部导航栏/头部
    '.top',
    

    // 面包屑导航
    

    // 侧边栏/侧边导航
 

    // 页脚
    

    // 浮动元素/回到顶部/工具栏
    

    // 版权信息/备案信息


    // 广告/弹窗遮罩
  ],
  // 紧凑布局配置：当内容div距顶部过远时，压缩间距让内容提上去（保留头部）
  compactLayout: {
    // 需要紧凑处理的内容选择器（按优先级排列）
    contentSelectors: [
      '.sj_arc_body', '.article-content', '.TRS_Editor',
      '.Custom_UnionStyle', '.pages_content', '#content',
      '.content', 'article', 'main',
    ],
    // 内容div距顶部超过此值才触发紧凑处理（px）
    compactThreshold: 400,
  },
};