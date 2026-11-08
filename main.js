'use strict';

/**
 * DeepSeek Harness (dsh) 桌面客户端 —— Intel (x64) macOS 适配版
 *
 * 流程：
 *   1. 启动 → 显示科技感启动页（login.html），用户输入用户名 + API Key + 选择基础模型；
 *   2. 主进程校验 API Key（调用 DeepSeek /models），验证通过后保存配置；
 *   3. 用「随应用内置的 Node 22 LTS」运行官方 dsh 的 bin.js（--profile web --no-open），
 *      注入 API Key 与默认模型 patch，从 stdout 解析启动 URL；
 *   4. 同一窗口加载 dsh 本地回环地址，进入主界面。
 *
 * 为什么内置 Node 22 LTS（>=22.19）而非系统 Node 或 Node 24：
 *   dsh 的 JS 依赖多项较新特性（import.meta.main、node:zlib zstd 等，Node 22.19+ 已回移植），
 *   同时 dsh 的原生模块 node-addon-require-builtin 是 NAPI v9（Node 22 ABI），
 *   与 Node 24 的 NAPI v10 不兼容（symbol not found: _napi_create_error）。
 */

const { app, BrowserWindow, dialog, shell, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');

const APP_DIR = app.getAppPath();
const DSH_BIN = path.join(APP_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const BUNDLED_NODE = path.join(process.resourcesPath, 'node-runtime', 'bin', 'node');
const LOGIN_HTML = path.join(APP_DIR, 'login.html');

const DEEPSEEK_API_ROOT = 'https://api.deepseek.com';

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

/** 读取 $DSH_HOME/.env，解析 KEY=VALUE */
function loadDotEnv(dshHome) {
  const result = {};
  try {
    const envPath = path.join(dshHome, '.env');
    if (!fs.existsSync(envPath)) return result;
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key) result[key] = value;
    }
  } catch (_) { /* ignore */ }
  return result;
}

/** 写入/更新 $DSH_HOME/.env 的某个 KEY=VALUE，保留其它行 */
function saveDotEnvKey(dshHome, key, value) {
  const envPath = path.join(dshHome, '.env');
  const lines = [];
  try {
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) { lines.push(line); continue; }
        const eq = t.indexOf('=');
        const k = eq > 0 ? t.slice(0, eq).trim() : '';
        if (k === key) continue; // 删除旧值，稍后统一追加
        lines.push(line);
      }
    }
  } catch (_) { /* ignore */ }
  lines.push(`${key}=${value}`);
  fs.mkdirSync(dshHome, { recursive: true });
  fs.writeFileSync(envPath, lines.join('\n') + '\n', { mode: 0o600 });
}

/** 读取应用启动配置（用户名/模型，不含 Key） */
function loadAppConfig(dshHome) {
  try {
    const p = path.join(dshHome, 'app-config.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) { /* ignore */ }
  return {};
}

function saveAppConfig(dshHome, cfg) {
  fs.mkdirSync(dshHome, { recursive: true });
  fs.writeFileSync(path.join(dshHome, 'app-config.json'), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

/** 生成默认模型 patch，通过 --patch 传给 dsh，把基础模型设为用户所选 */
function writeModelPatch(dshHome, model) {
  const p = path.join(dshHome, '.model-patch.yml');
  const patch = `- id: agent-default-model\n  config:\n    model: ${model}\n`;
  fs.mkdirSync(dshHome, { recursive: true });
  fs.writeFileSync(p, patch);
  return p;
}

/**
 * 校验 DeepSeek API Key：调用 GET /models。
 * 200 有效；401 Key 无效；402 余额不足；429 限流；其它为服务端/网络错误。
 */
function verifyApiKey(apiKey) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.deepseek.com',
      path: '/models',
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': 'dsh-desktop-intel' },
      timeout: 20000,
    }, (res) => {
      res.resume();
      res.on('end', () => {
        switch (res.statusCode) {
          case 200: return resolve({ ok: true });
          case 401: return resolve({ ok: false, error: 'API Key 无效或已过期（401），请检查后重试' });
          case 402: return resolve({ ok: false, error: '账户余额不足（402），请到 platform.deepseek.com 充值' });
          case 429: return resolve({ ok: false, error: '请求过于频繁（429），请稍后再试' });
          default: return resolve({ ok: false, error: `验证失败（HTTP ${res.statusCode}）` });
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ ok: false, error: '无法连接 DeepSeek API：' + e.message }));
    req.end();
  });
}

/** 清理陈旧原子写锁（避免 dsh 启动时等锁超时） */
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

/** 启动 dsh web 服务，返回带 token 的启动 URL */
function startDsh(apiKey, model) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(DSH_BIN)) return reject(new Error('未找到 dsh 包：' + DSH_BIN));
    const nodeBin = findNode();
    const dshHome = resolveDshHome();
    cleanupStaleLocks(dshHome);
    const modelPatch = model ? writeModelPatch(dshHome, model) : null;

    log('[boot] node =', nodeBin);
    log('[boot] DSH_HOME =', dshHome);
    log('[boot] model =', model || '(默认)');

    const env = Object.assign({}, process.env, {
      DSH_HOME: dshHome,
      NO_COLOR: '1',
      NODE_OPTIONS: '',
    });
    // 合并 .env（含已保存的 DEEPSEEK_API_KEY），再显式注入本次 key
    for (const [k, v] of Object.entries(loadDotEnv(dshHome))) {
      if (!(k in env)) env[k] = v;
    }
    if (apiKey) env.DEEPSEEK_API_KEY = apiKey;

    const args = [DSH_BIN, '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'];
    if (modelPatch) args.push('--patch', modelPatch);

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
    dshProc.stderr.on('data', (chunk) => log('[dsh:err]', chunk.toString().trim()));
    dshProc.on('error', (err) => reject(new Error('无法启动 dsh 进程：' + err.message)));
    dshProc.on('exit', (code) => {
      log('[dsh] 进程退出，code =', code);
      if (!resolvedUrl) reject(new Error('dsh 在就绪前退出（code=' + code + '），详见日志'));
    });
    setTimeout(() => {
      if (!resolvedUrl) reject(new Error('等待 dsh Web 服务就绪超时（180s）'));
    }, 180000).unref();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 820,
    minHeight: 620,
    title: 'DeepSeek Harness',
    backgroundColor: '#060913',
    show: false,
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(LOGIN_HTML);
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/i.test(u)) shell.openExternal(u);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

/* ---------------- IPC ---------------- */

ipcMain.handle('dsh:get-config', () => {
  const dshHome = resolveDshHome();
  const cfg = loadAppConfig(dshHome);
  const hasKey = !!loadDotEnv(dshHome).DEEPSEEK_API_KEY;
  return { username: cfg.username || '', model: cfg.model || 'deepseek-v4-pro', hasKey };
});

ipcMain.handle('dsh:open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
});

ipcMain.handle('dsh:login', async (_e, payload) => {
  const dshHome = resolveDshHome();
  const username = String(payload && payload.username || '').trim();
  const apiKey = String(payload && payload.apiKey || '').trim();
  const model = String(payload && payload.model || 'deepseek-v4-pro').trim();
  if (!username) return { ok: false, error: '用户名不能为空' };

  const existingKey = loadDotEnv(dshHome).DEEPSEEK_API_KEY || '';
  const keyToUse = apiKey || existingKey;
  if (!keyToUse) return { ok: false, error: '请填写 API Key' };

  log('[login] 校验 API Key，用户 =', username, '，模型 =', model);
  const v = await verifyApiKey(keyToUse);
  if (!v.ok) return v;

  // 保存配置：Key 写入 .env，用户名/模型写入 app-config.json
  saveDotEnvKey(dshHome, 'DEEPSEEK_API_KEY', keyToUse);
  saveAppConfig(dshHome, { username, model });

  log('[login] 校验通过，启动 dsh ...');
  try {
    const url = await startDsh(keyToUse, model);
    return { ok: true, url };
  } catch (err) {
    log('[login] 启动 dsh 失败：', err.message);
    return { ok: false, error: '启动失败：' + err.message };
  }
});

/* ---------------- 生命周期 ---------------- */

app.whenReady().then(() => {
  log('====== DeepSeek Harness (Intel) 启动 ======');
  log('[env] arch =', process.arch, ', platform =', process.platform, ', electron =', process.versions.electron);
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  if (dshProc && !dshProc.killed) {
    log('[quit] 正在停止 dsh 子进程');
    try {
      dshProc.kill('SIGINT');
      const t = setTimeout(() => { try { dshProc.kill('SIGTERM'); } catch (_) {} }, 3000);
      t.unref();
    } catch (_) { /* ignore */ }
  }
});
