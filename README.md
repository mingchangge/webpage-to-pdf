# Webpage-to-PDF

网页 PDF 快照爬取工具，基于 Puppeteer 批量抓取网页并生成 PDF，同时支持将 Office 文档（doc/docx/xls/xlsx/ppt/pptx）和 OFD 文件转换为 PDF。

## 功能特性

- **网页转 PDF**：使用 Puppeteer（无头 Chrome）渲染网页，生成排版保真的 PDF 快照
- **Office 文档转 PDF**：下载 doc/docx/xls/xlsx/ppt/pptx/rtf/wps 文件，通过 LibreOffice 转 HTML 后由 Chrome 渲染为 PDF，彻底解决中文乱码问题
- **PDF 文件直接下载**：检测到 PDF 链接时直接下载保存
- **OFD 文件渲染**：使用 ofd.js 在浏览器中渲染 OFD 文件并生成 PDF
- **智能 DOM 清理**：自动移除页面中的导航栏、页脚、广告等非内容元素
- **并发控制**：可配置并发数，分批处理大量页面
- **自动重试**：失败任务自动重试，支持 `--retry-failed` 仅重试上次失败项
- **爬取报告**：自动生成 JSON 格式的爬取报告，包含成功/失败统计和文件大小

## 环境要求

- **Node.js** >= 18.0.0
- **LibreOffice**（可选，转换 Office 文档时需要）
  - macOS：安装后路径通常为 `/Applications/LibreOffice.app/Contents/MacOS/soffice`
  - Linux：通常为 `libreoffice`

## 安装

```bash
npm install
```
## 配置

### URL 列表

在项目根目录创建 `urls.json` 文件：

```json
[ { "url": "https://example.com/page1", "title": "页面标题1" }, { "url": "https://example.com/doc/demo.docx", "title": "文档标题2" } ]
```


### 全局配置

编辑 [config.js](config.js) 可调整以下参数：

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `outputDir` | PDF 输出目录 | `./output` |
| `browser.headless` | 是否无头模式 | `true` |
| `page.timeout` | 页面超时时间 | `60000ms` |
| `page.extraWait` | 页面加载后额外等待 | `3000ms` |
| `pdf.format` | PDF 纸张格式 | `A4` |
| `pdf.margin` | PDF 页边距 | 上下 20mm，左右 15mm |
| `viewport` | 浏览器视口尺寸 | 1280×800 |
| `retry.maxAttempts` | 最大重试次数 | 3 |
| `concurrency` | 并发数 | 2 |
| `libreofficePath` | LibreOffice 路径 | macOS 默认路径 |
| `removeSelectors` | 需移除的 DOM 选择器 | 常见导航/页脚选择器 |

## 使用方法

### 基本用法

```bash
# 爬取 urls.json 中的所有页面
npm start

# 无头模式运行
npm run start:headless
```

### 命令行参数

```bash
# 限制爬取数量（仅爬取前 1 个，用于测试）
npm test
# 等同于
node index.js --limit 1

# 仅重试上次失败项
npm run retry-failed
# 等同于
node index.js --retry-failed

# 直接爬取单个 URL
node index.js https://example.com/page1
```

### 输出结果

PDF 文件和爬取报告保存在 `output/` 目录下：
```text
output/ 
├── 202601_页面标题.pdf 
├── 202601_文档标题.pdf 
└── report.json
```
`report.json` 包含爬取的详细统计信息：
```json
{ 
    "timestamp": "2026-01-12T10:00:00.000Z", 
    "total": 10, 
    "success": 9, 
    "failed": 1, 
    "totalSizeMB": 12.34, 
    "items": [...] 
}
```