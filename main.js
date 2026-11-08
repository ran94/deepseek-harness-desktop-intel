'use strict';

/**
 * DeepSeek Harness (dsh) 桌面客户端 —— Intel (x64) macOS 适配版
 *
 * 架构：
 *   1. 用「随应用内置的官方 Node 24 运行时」运行官方 npm 包 @deepseek-ai/dsh 的 CLI
 *      （bin.js），`--profile web --no-open`，启动 dsh 内置的本地 Web 服务；
 *   2. 从 stdout 解析出带进程 token 的启动 URL（形如
 *      `dsh web: http://127.0.0.1:PORT/?token=...`）；
 *   3. 用 Electron 的 BrowserWindow 加载该回环地址，天然同源、零 CORS / 零鉴权改造。
 *
 * 为什么必须内置 Node 24：
 *   dsh 依赖多项 Node 24 特性（import.meta.main、node:zlib.createZstdCompress、
 *   node:util.getSystemErrorMessage、node:module.stripTypeScriptTypes 等），
 *   系统自带 Node 22 不提供这些；官方桌面版仅发布 Apple Silicon + Windows x64，
 *   因此这里打包 darwin-x64 的 Electron 与 Node 24，供 Intel MacBook Pro 稳定运行。
 */

const { app, BrowserWindow, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_DIR = app.getAppPath();
const DSH_BIN = path.join(APP_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const BUNDLED_NODE = path.join(process.resourcesPath, 'node-runtime', 'bin', 'node');

let dshProc = null;
let mainWindow = null;
let resolvedUrl = null;

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(' ')}`;
  console.log(line);
  try {
    const logPath = path.join(app.getPath('userData'), 'dsh-desktop.log');
    fs.appendFileSync(logPath, line + '\n');
  } catch (_) { /* ignore */ }
}

/**
 * 定位 Node 可执行文件。优先使用随应用内置的官方 Node 24 运行时，
 * 保证 dsh 所需的 Node 24 特性全部可用、且不受宿主环境限制。
 */
function findNode() {
  const candidates = [
    process.env.DSH_NODE,
    BUNDLED_NODE,
    '/usr/local/opt/node/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'node';
}

function resolveDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/**
 * 清理上次异常退出遗留的原子写锁（如 .credentials.yaml.lock 及其 takeover 变体）。
 * 这些锁由 dsh 的 dsh-atomic-write 以 wx 标志创建，进程被强杀时会残留，
 * 导致下一次 dsh 启动在 connection 插件处等锁超时。应用自身独占 dsh 生命周期，
 * 因此启动时存在的这类锁一定是陈旧的。
 */
function cleanupStaleLocks(dshHome) {
  try {
    if (!fs.existsSync(dshHome)) return;
    const entries = fs.readdirSync(dshHome, { withFileTypes: true });
    let removed = 0;
    for (const e of entries) {
      if (e.isFile() && (e.name === '.credentials.yaml.lock' || e.name.startsWith('.credentials.yaml.lock.'))) {
        fs.rmSync(path.join(dshHome, e.name), { force: true });
        removed += 1;
      }
    }
    if (removed > 0) log('[boot] 已清理陈旧锁文件', removed, '个');
  } catch (_) { /* ignore */ }
}

function startDsh() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(DSH_BIN)) {
      return reject(new Error('未找到 dsh 包：' + DSH_BIN));
    }
    const nodeBin = findNode();
    const dshHome = resolveDshHome();
    cleanupStaleLocks(dshHome);
    log('[boot] node =', nodeBin);
    log('[boot] dsh  =', DSH_BIN);
    log('[boot] DSH_HOME =', dshHome);

    const env = Object.assign({}, process.env, {
      DSH_HOME: dshHome,
      NO_COLOR: '1',
      // 关键：清空 NODE_OPTIONS，避免宿主的 Node 拦截 shim 注入到 dsh 导致挂起。
      NODE_OPTIONS: '',
    });

    const args = [DSH_BIN, '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'];
    dshProc = spawn(nodeBin, args, {
      env,
      cwd: path.dirname(DSH_BIN),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    dshProc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdoutBuf += text;
      log('[dsh:out]', text.trim());
      const m = stdoutBuf.match(/dsh web:\s*(https?:\/\/\S+)/i);
      if (m && !resolvedUrl) {
        resolvedUrl = m[1];
        log('[boot] 已解析启动 URL:', resolvedUrl);
        resolve(resolvedUrl);
      }
    });

    dshProc.stderr.on('data', (chunk) => {
      log('[dsh:err]', chunk.toString().trim());
    });

    dshProc.on('error', (err) => {
      reject(new Error('无法启动 dsh 进程：' + err.message));
    });

    dshProc.on('exit', (code) => {
      log('[dsh] 进程退出，code =', code);
      if (!resolvedUrl) {
        reject(new Error('dsh 在就绪前退出（code=' + code + '），详见日志'));
      }
    });

    // dsh 首次启动需加载数百个插件，Intel 老机型上可达 1-3 分钟，超时设宽松。
    setTimeout(() => {
      if (!resolvedUrl) {
        reject(new Error('等待 dsh Web 服务就绪超时（180s）'));
      }
    }, 180000).unref();
  });
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 800,
    minHeight: 600,
    title: 'DeepSeek Harness',
    backgroundColor: '#101014',
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadURL(url);

  mainWindow.webContents.on('did-finish-load', () => log('[web] 页面加载完成'));
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, failedUrl) => {
    log('[web] 加载失败:', code, desc, failedUrl);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/i.test(u)) shell.openExternal(u);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  log('====== DeepSeek Harness (Intel) 启动 ======');
  log('[env] arch =', process.arch, ', platform =', process.platform, ', electron =', process.versions.electron);
  try {
    const url = await startDsh();
    createWindow(url);
  } catch (err) {
    log('[fatal]', err.message);
    dialog.showErrorBox('DeepSeek Harness 启动失败', err.message + '\n\n日志：' + path.join(app.getPath('userData'), 'dsh-desktop.log'));
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && resolvedUrl) {
    createWindow(resolvedUrl);
  }
});

app.on('before-quit', () => {
  if (dshProc && !dshProc.killed) {
    log('[quit] 正在停止 dsh 子进程');
    try {
      // 先温和 SIGINT 给 dsh 释放锁的机会，超时后再 SIGTERM
      dshProc.kill('SIGINT');
      const t = setTimeout(() => { try { dshProc.kill('SIGTERM'); } catch (_) {} }, 3000);
      t.unref();
    } catch (_) { /* ignore */ }
  }
});
