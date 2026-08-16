const { app, BrowserWindow, protocol, session, shell, net } = require('electron');
const path = require('path');
const fs   = require('fs');
const { pathToFileURL } = require('url');

// ── 数据根目录解析
//    打包后：resources/ 目录是数据所在的位置（accounts/ 或 wayback_snapshots/ 都在这里）
//    开发时：项目根目录（同 main.js 所在目录）
function getDataBaseDir() {
  if (app.isPackaged) {
    return process.resourcesPath;
  }
  return __dirname;
}

const mimeMap = {
  '.html': 'text/html', '.htm': 'text/html',
  '.js':   'application/javascript', '.css': 'text/css',
  '.json': 'application/json',
  '.png':  'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif':  'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp4':  'video/mp4', '.webm': 'video/webm',
  '.txt':  'text/plain',
};

// 存档快照里剥离 <script>（双保险：iframe 沙箱已禁用脚本，这里再兜一层——
// 即使以后放宽 sandbox，或用户直接用浏览器打开快照文件，也不会执行任何脚本）
function sanitizeSnapshotHtml(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<script\b[^>]*\/>/gi, '');
}

// ── 注册自定义协议 incr://，让 Reader.html 通过它读取本地文件
// 这样完全绕开 file:// 的跨域限制，fetch() 正常工作
//
// URL 路由规则：
//   incr://local/_accounts                      → 动态扫描 accounts/ 下所有子目录，
//                                                  读取每个的 profile.json 合成账号清单 JSON
//   incr://local/accounts/AnIncandescence/...   → DATA/accounts/AnIncandescence/...
//   incr://local/wayback_snapshots/...          → DATA/wayback_snapshots/... (向后兼容旧目录)
//   incr://local/Reader.html / 其他静态资源      → __dirname/...
//
// 用 protocol.handle（流式）而非 registerBufferProtocol（整文件进内存）：
// 视频/大图不再在主进程同步读入并翻倍内存。
function registerProtocol() {
  protocol.handle('incr', async (request) => {
    let urlPath;
    try {
      urlPath = request.url.replace('incr://local/', '');
      // 去掉查询参数和 hash（Reader.html 加载 index.json 时会附加 ?_t= 缓存破坏参数）
      const qIdx = urlPath.search(/[?#]/);
      if (qIdx !== -1) urlPath = urlPath.slice(0, qIdx);
      // 解码 URI（畸形 % 序列会抛异常，直接拒绝）
      urlPath = decodeURIComponent(urlPath);
    } catch (e) {
      return new Response(null, { status: 400 });
    }

    const dataBase = getDataBaseDir();

    // 虚拟路径：扫 accounts/ 下所有子目录，组合 profile.json 生成账号清单
    if (urlPath === '_accounts' || urlPath === '_accounts.json') {
      const accountsDir = path.join(dataBase, 'accounts');
      let list = [];
      try {
        if (fs.existsSync(accountsDir)) {
          const dirs = fs.readdirSync(accountsDir, { withFileTypes: true })
            .filter(d => d.isDirectory() && !d.name.startsWith('.'))
            .map(d => d.name);

          for (const dir of dirs) {
            const profilePath = path.join(accountsDir, dir, 'wayback_snapshots', 'profile.json');
            if (!fs.existsSync(profilePath)) continue;
            try {
              const prof = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
              list.push({
                dir: dir,
                name:     prof.name     || dir,
                username: prof.username || dir,
                bio:      prof.bio      || '',
                avatar:   prof.avatar   ? `accounts/${dir}/wayback_snapshots/${prof.avatar}` : '',
                banner:   prof.banner   ? `accounts/${dir}/wayback_snapshots/${prof.banner}` : '',
              });
            } catch (e) {
              // 跳过坏掉的 profile.json
              console.error(`[incr] 解析 ${profilePath} 失败:`, e.message);
            }
          }
        }
      } catch (e) {
        console.error('[incr] 扫描 accounts/ 失败:', e);
      }
      return new Response(JSON.stringify(list), {
        headers: { 'content-type': 'application/json' },
      });
    }

    // 实文件路径
    // 安全：解析后必须仍位于允许的根目录内，防止 incr://local/../../任意文件
    // 被 iframe 内的存档页利用（fetch 穿越读取本地文件）
    const isDataPath = urlPath.startsWith('accounts/') || urlPath.startsWith('wayback_snapshots/');
    const baseDir = isDataPath ? dataBase : __dirname;
    const filePath = path.resolve(baseDir, urlPath);
    if (filePath !== baseDir && !filePath.startsWith(baseDir + path.sep)) {
      return new Response(null, { status: 403 });
    }

    // 流式返回文件（用 net.fetch 读 file:// 并透传 body，避免整文件读入内存）
    try {
      const fileRes = await net.fetch(pathToFileURL(filePath).toString());
      if (!fileRes.ok) {
        return new Response(null, { status: 404 });
      }
      const ext = path.extname(filePath).toLowerCase();
      const mime = mimeMap[ext] || 'application/octet-stream';
      // 存档 HTML 快照：剥离脚本（双保险，见 sanitizeSnapshotHtml）
      if (isDataPath && (ext === '.html' || ext === '.htm')) {
        const html = sanitizeSnapshotHtml(await fileRes.text());
        return new Response(html, { headers: { 'content-type': mime } });
      }
      return new Response(fileRes.body, {
        headers: { 'content-type': mime },
      });
    } catch (e) {
      return new Response(null, { status: 404 });
    }
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width:  1440,
    height: 900,
    minWidth:  900,
    minHeight: 600,
    title: '白炽阅读器 · IncandescenceReader',
    backgroundColor: '#000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // 允许 incr:// 协议页面访问本地资源
      webviewTag: false,
    },
    // 无边框可选，保留系统标题栏更稳定
    frame: true,
    show: false, // 加载完再显示，避免白屏闪烁
  });

  win.once('ready-to-show', () => win.show());

  // ── 窗口安全策略 ──
  // 1) 新窗口：http/https 交给系统浏览器打开，其余一律拒绝
  //    （存档页/推文链接不再弹出 Electron 窗口）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  // 2) 顶层导航只允许留在应用自身页面，禁止被导航到外部 URL
  //    （loadURL 等程序化导航不会触发本事件）
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('incr://local/')) event.preventDefault();
  });

  win.loadURL('incr://local/Reader.html');

  // 开发时打开 DevTools（打包后注释掉）
  // win.webContents.openDevTools();
}

// 权限加固：存档内容（iframe 内）一律拒绝任何权限请求（通知/地理位置等）
// 注意：Electron 未设置处理器时默认自动批准权限请求，必须显式拒绝
function hardenPermissions() {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
}

// 必须在 app ready 之前调用，否则新版 Electron 中自定义协议权限不生效
protocol.registerSchemesAsPrivileged([
  { scheme: 'incr', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);

// 单实例：重复启动时聚焦已有窗口并退出新进程
// （避免多实例同时读写 localStorage / 互相干扰）
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

app.whenReady().then(() => {
  registerProtocol();
  hardenPermissions();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
