/**
 * PDF 逐个预览器：在浏览器中逐个查看 PDF，标记问题项，最后导出
 * 用法: node scripts/pdf-viewer.js
 * 打开 http://localhost:3210 即可使用
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = 3210;
const PDFS_DIR = path.join(__dirname, '..', 'output');
const FLAGS_FILE = path.join(PDFS_DIR, '_flags.json');

// 获取 PDF 文件列表（仅当前目录下的 .pdf 文件，排除子目录）
function getPdfList() {
  if (!fs.existsSync(PDFS_DIR)) return [];
  return fs
    .readdirSync(PDFS_DIR)
    .filter((f) => f.toLowerCase().endsWith('.pdf') && fs.statSync(path.join(PDFS_DIR, f)).isFile())
    .sort();
}

// 读取已有的标记数据
function loadFlags() {
  if (fs.existsSync(FLAGS_FILE)) {
    return JSON.parse(fs.readFileSync(FLAGS_FILE, 'utf-8'));
  }
  return [];
}

// 保存标记数据
function saveFlags(flags) {
  fs.writeFileSync(FLAGS_FILE, JSON.stringify(flags, null, 2), 'utf-8');
}

// 内嵌的 HTML 页面
const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>PDF 预览器</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f5f5f5; height: 100vh; display: flex; flex-direction: column; }

  /* 顶部导航栏 */
  .navbar { background: #1a1a2e; color: #fff; padding: 10px 20px; display: flex; align-items: center; gap: 15px; flex-shrink: 0; }
  .navbar h1 { font-size: 16px; font-weight: 600; white-space: nowrap; }
  .nav-info { font-size: 14px; color: #aaa; }
  .nav-btns { display: flex; gap: 8px; margin-left: auto; }
  .btn { padding: 6px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 500; transition: all .15s; }
  .btn:disabled { opacity: .4; cursor: not-allowed; }
  .btn-nav { background: #16213e; color: #fff; border: 1px solid #444; }
  .btn-nav:hover:not(:disabled) { background: #0f3460; }
  .btn-flag { background: #e94560; color: #fff; }
  .btn-flag:hover { background: #c81e45; }
  .btn-export { background: #0f3460; color: #fff; }
  .btn-export:hover { background: #16213e; }
  .btn-clear { background: transparent; color: #aaa; border: 1px solid #555; }
  .btn-clear:hover { color: #fff; border-color: #888; }

  /* 主体区域 */
  .main { display: flex; flex: 1; overflow: hidden; }

  /* PDF 查看区 */
  .viewer { flex: 1; display: flex; flex-direction: column; }
  .pdf-frame { flex: 1; border: none; background: #e0e0e0; }
  .filename-bar { background: #fff; padding: 8px 20px; font-size: 13px; color: #555; border-bottom: 1px solid #ddd; display: flex; align-items: center; gap: 10px; }
  .filename-bar .name { font-weight: 600; color: #333; }

  /* 右侧面板 - 标记区 */
  .sidebar { width: 340px; background: #fff; border-left: 1px solid #ddd; display: flex; flex-direction: column; flex-shrink: 0; }
  .sidebar-header { padding: 15px; border-bottom: 1px solid #eee; }
  .sidebar-header h2 { font-size: 15px; margin-bottom: 10px; }

  /* 标记表单 */
  .flag-form { padding: 15px; border-bottom: 1px solid #eee; }
  .flag-form label { display: block; font-size: 13px; color: #666; margin-bottom: 5px; }
  .flag-form select, .flag-form textarea, .flag-form input {
    width: 100%; padding: 6px 8px; border: 1px solid #ddd; border-radius: 4px;
    font-size: 13px; font-family: inherit; margin-bottom: 10px;
  }
  .flag-form textarea { height: 60px; resize: vertical; }
  .flag-form .btn { width: 100%; }

  /* 已标记列表 */
  .flag-list { flex: 1; overflow-y: auto; padding: 10px 15px; }
  .flag-list h3 { font-size: 14px; margin-bottom: 8px; color: #333; }
  .flag-item { background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; padding: 10px; margin-bottom: 8px; font-size: 12px; }
  .flag-item .flag-title { font-weight: 600; color: #b91c1c; margin-bottom: 4px; word-break: break-all; }
  .flag-item .flag-type { color: #dc2626; font-weight: 500; }
  .flag-item .flag-note { color: #666; margin-top: 4px; word-break: break-all; }
  .flag-item .flag-actions { margin-top: 6px; }
  .flag-item .btn-sm { padding: 2px 8px; font-size: 11px; background: #fee2e2; color: #b91c1c; border: 1px solid #fecaca; border-radius: 3px; cursor: pointer; }
  .flag-item .btn-sm:hover { background: #fecaca; }

  .sidebar-footer { padding: 15px; border-top: 1px solid #eee; display: flex; gap: 8px; }
  .sidebar-footer .btn { flex: 1; }

  /* 空状态 */
  .empty { text-align: center; padding: 40px 20px; color: #999; font-size: 14px; }

  /* 快捷键提示 */
  .shortcuts { font-size: 11px; color: #888; padding: 5px 20px; background: #fafafa; border-top: 1px solid #eee; }
  kbd { background: #eee; padding: 1px 5px; border-radius: 3px; font-size: 11px; border: 1px solid #ccc; }
</style>
</head>
<body>

<!-- 顶部导航 -->
<div class="navbar">
  <h1>📄 PDF 预览器</h1>
  <span class="nav-info" id="navInfo">0 / 0</span>
  <div class="nav-btns">
    <button class="btn btn-nav" id="btnPrev" onclick="go(-1)">◀ 上一个</button>
    <button class="btn btn-nav" id="btnNext" onclick="go(1)">下一个 ▶</button>
  </div>
</div>

<!-- 主体 -->
<div class="main">
  <!-- PDF 查看区 -->
  <div class="viewer">
    <div class="filename-bar">
      <span>文件：</span>
      <span class="name" id="currentFile">-</span>
    </div>
    <iframe class="pdf-frame" id="pdfFrame"></iframe>
    <div class="shortcuts">
      快捷键：<kbd>←</kbd> 上一个 &nbsp; <kbd>→</kbd> 下一个 &nbsp; <kbd>F</kbd> 标记问题 &nbsp; <kbd>S</kbd> 跳过
    </div>
  </div>

  <!-- 右侧面板 -->
  <div class="sidebar">
    <div class="sidebar-header">
      <h2>🚩 问题标记</h2>
      <div style="font-size:12px;color:#888">发现问题点击标记，最后统一导出处理</div>
    </div>

    <div class="flag-form" id="flagForm">
      <label>问题类型</label>
      <select id="flagType">
        <option value="内容不全">内容不全（截图不完整）</option>
        <option value="文件损坏">文件损坏（无法打开）</option>
        <option value="命名错误">命名错误（需重命名）</option>
        <option value="重复文件">重复文件（需去重）</option>
        <option value="需重新下载">需重新下载</option>
        <option value="其他">其他</option>
      </select>
      <label>备注</label>
      <textarea id="flagNote" placeholder="描述具体问题..."></textarea>
      <button class="btn btn-flag" onclick="flagCurrent()">🚩 标记当前 PDF 有问题</button>
    </div>

    <div class="flag-list" id="flagList">
      <h3>已标记 (<span id="flagCount">0</span>)</h3>
      <div id="flagItems"></div>
    </div>

    <div class="sidebar-footer">
      <button class="btn btn-export" onclick="exportFlags()">📥 导出标记</button>
      <button class="btn btn-clear" onclick="clearAllFlags()">清空</button>
    </div>
  </div>
</div>

<script>
let pdfs = [];
let current = 0;
let flags = [];

// 初始化
async function init() {
  const res = await fetch('/api/pdfs');
  pdfs = await res.json();

  const fRes = await fetch('/api/flags');
  flags = await fRes.json();

  renderFlags();
  if (pdfs.length > 0) show(0);
  else document.getElementById('pdfFrame').style.display = 'none';
}

function show(idx) {
  if (idx < 0 || idx >= pdfs.length) return;
  current = idx;
  document.getElementById('pdfFrame').src = '/api/pdf/' + encodeURIComponent(pdfs[idx]);
  document.getElementById('currentFile').textContent = pdfs[idx];
  document.getElementById('navInfo').textContent = (idx + 1) + ' / ' + pdfs.length;
  document.getElementById('btnPrev').disabled = idx === 0;
  document.getElementById('btnNext').disabled = idx === pdfs.length - 1;
}

function go(delta) { show(current + delta); }

// 标记当前 PDF
async function flagCurrent() {
  if (pdfs.length === 0) return;
  const type = document.getElementById('flagType').value;
  const note = document.getElementById('flagNote').value.trim();
  const filename = pdfs[current];

  // 检查是否已标记
  const existing = flags.find(f => f.filename === filename);
  if (existing) {
    existing.type = type;
    existing.note = note;
    existing.time = new Date().toISOString();
  } else {
    flags.push({ filename, type, note, time: new Date().toISOString() });
  }

  await fetch('/api/flags', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(flags) });
  document.getElementById('flagNote').value = '';
  renderFlags();

  // 自动跳到下一个
  if (current < pdfs.length - 1) go(1);
}

// 删除标记
async function removeFlag(filename) {
  flags = flags.filter(f => f.filename !== filename);
  await fetch('/api/flags', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(flags) });
  renderFlags();
}

// 渲染标记列表
function renderFlags() {
  document.getElementById('flagCount').textContent = flags.length;
  const container = document.getElementById('flagItems');
  if (flags.length === 0) {
    container.innerHTML = '<div class="empty">暂无标记</div>';
    return;
  }
  container.innerHTML = flags.map(f =>
    '<div class="flag-item">' +
      '<div class="flag-title">' + f.filename + '</div>' +
      '<div class="flag-type">类型：' + f.type + '</div>' +
      (f.note ? '<div class="flag-note">备注：' + f.note + '</div>' : '') +
      '<div class="flag-actions"><button class="btn-sm" onclick="removeFlag(\\'' + f.filename + '\\')">删除标记</button></div>' +
    '</div>'
  ).join('');
}

// 导出标记
function exportFlags() {
  if (flags.length === 0) { alert('没有标记项'); return; }
  const blob = new Blob([JSON.stringify(flags, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'pdf-flags-' + new Date().toISOString().slice(0,10) + '.json';
  a.click();
  URL.revokeObjectURL(url);
}

// 清空标记
async function clearAllFlags() {
  if (!confirm('确定清空所有标记？')) return;
  flags = [];
  await fetch('/api/flags', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(flags) });
  renderFlags();
}

// 键盘快捷键
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowLeft') go(-1);
  else if (e.key === 'ArrowRight') go(1);
  else if (e.key === 'f' || e.key === 'F') flagCurrent();
  else if (e.key === 's' || e.key === 'S') { if (current < pdfs.length - 1) go(1); }
});

init();
</script>
</body>
</html>`;

// HTTP 服务器
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // 首页
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  // API: 获取 PDF 列表
  if (url.pathname === '/api/pdfs') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getPdfList()));
    return;
  }

  // API: 获取单个 PDF 文件
  if (url.pathname.startsWith('/api/pdf/')) {
    const filename = decodeURIComponent(url.pathname.slice('/api/pdf/'.length));
    const filePath = path.join(PDFS_DIR, filename);

    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': stat.size,
      'Content-Disposition': `inline; filename="${encodeURIComponent(filename)}"`,
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // API: 读取标记
  if (url.pathname === '/api/flags' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(loadFlags()));
    return;
  }

  // API: 保存标记
  if (url.pathname === '/api/flags' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const flags = JSON.parse(body);
      saveFlags(flags);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('='.repeat(50));
  console.log('📄 PDF 预览器已启动');
  console.log('='.repeat(50));
  console.log(`\n  打开浏览器访问: http://localhost:${PORT}\n`);
  console.log('快捷键：');
  console.log('  ← →   上一个/下一个');
  console.log('  F      标记当前 PDF 有问题');
  console.log('  S      跳过（下一个）');
  console.log('\n按 Ctrl+C 退出\n');

  const pdfs = getPdfList();
  console.log(`共 ${pdfs.length} 个 PDF 待查看：`);
  pdfs.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
});