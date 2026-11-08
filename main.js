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

// 性能优化：窗口后台时禁止渲染进程降频/暂停，保持界面切换流畅、响应即时
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

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

const PROFILE_ROOT = path.join(os.homedir(), '.dsh-profiles');

/** 安全化用户名，作为独立数据目录名 */
function sanitizeUsername(username) {
  const clean = String(username || '').replace(/[\/\\:*?"<>|]/g, '_').trim();
  return clean || 'default';
}

/**
 * 解析用户的 dsh 数据目录（DSH_HOME）。
 * 每个用户名对应独立目录，实现会话/历史/配置隔离；未登录时回退到默认 ~/.dsh。
 */
function resolveDshHome(username) {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  if (!username) return path.join(os.homedir(), '.dsh');
  return path.join(PROFILE_ROOT, sanitizeUsername(username));
}

/** 读取上次登录的用户名 */
function getLastUser() {
  try {
    const p = path.join(PROFILE_ROOT, '.last-user');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  } catch (_) { /* ignore */ }
  return '';
}

function saveLastUser(username) {
  try {
    fs.mkdirSync(PROFILE_ROOT, { recursive: true });
    fs.writeFileSync(path.join(PROFILE_ROOT, '.last-user'), String(username));
  } catch (_) { /* ignore */ }
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

/** 生成 DeepSeek 官方默认模型 patch（config 为整体替换，须写全 provider + model） */
function buildDeepSeekPatch(model) {
  return `- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: ${model}\n`;
}

/** 生成自定义 OpenAI 兼容 provider patch（pi-ai 适配器 + 默认模型指向） */
function buildCustomPatch(baseURL, modelId) {
  return [
    `- id: llm-pi-ai`,
    `  config:`,
    `    providers:`,
    `      custom:`,
    `        displayName: 自定义模型`,
    `        apiKeyEnv: CUSTOM_API_KEY`,
    `        api: openai-completions`,
    `        baseURL: ${baseURL}`,
    `        models:`,
    `          - id: ${modelId}`,
    `- id: agent-default-model`,
    `  config:`,
    `    provider: custom`,
    `    model: ${modelId}`,
    ``,
  ].join('\n');
}

/** 写入 patch 文件，返回路径（通过 --patch 传给 dsh） */
function writePatch(dshHome, content) {
  const p = path.join(dshHome, '.model-patch.yml');
  fs.mkdirSync(dshHome, { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

/**
 * 校验 API Key：调用 GET {baseURL}/models（OpenAI 兼容的 models 端点）。
 * 200 有效；401 Key 无效；402 余额不足；429 限流；其它为服务端/网络错误。
 * 不传 baseURL 时默认用 DeepSeek 官方端点。
 */
function verifyApiKey(apiKey, baseURL) {
  return new Promise((resolve) => {
    let hostname, pathPrefix;
    try {
      const u = new URL(baseURL || DEEPSEEK_API_ROOT);
      hostname = u.hostname;
      pathPrefix = u.pathname.replace(/\/+$/, '');
    } catch (_) {
      return resolve({ ok: false, error: 'Base URL 格式无效' });
    }
    const req = https.request({
      hostname,
      path: pathPrefix + '/models',
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': 'dsh-desktop-intel' },
      timeout: 20000,
    }, (res) => {
      res.resume();
      res.on('end', () => {
        log('[login] verify HTTP', res.statusCode, 'for', hostname);
        switch (res.statusCode) {
          case 200: return resolve({ ok: true });
          case 401: return resolve({ ok: false, error: 'API Key 无效或已过期（401），请检查后重试' });
          case 402: return resolve({ ok: false, error: '账户余额不足（402），请先充值' });
          case 429: return resolve({ ok: false, error: '请求过于频繁（429），请稍后再试' });
          default: return resolve({ ok: false, error: `验证失败（HTTP ${res.statusCode}）` });
        }
      });
    });
    req.on('timeout', () => { log('[login] verify timeout'); req.destroy(new Error('timeout')); });
    req.on('error', (e) => { log('[login] verify error:', e.message); resolve({ ok: false, error: '无法连接 API：' + e.message }); });
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
function startDsh(patchContent, extraEnv, username) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(DSH_BIN)) return reject(new Error('未找到 dsh 包：' + DSH_BIN));
    const nodeBin = findNode();
    const dshHome = resolveDshHome(username);
    cleanupStaleLocks(dshHome);
    const modelPatch = patchContent ? writePatch(dshHome, patchContent) : null;

    log('[boot] node =', nodeBin);
    log('[boot] DSH_HOME =', dshHome);

    const env = Object.assign({}, process.env, {
      DSH_HOME: dshHome,
      NO_COLOR: '1',
      NODE_OPTIONS: '',
    });
    // 合并 .env（含已保存的 DEEPSEEK_API_KEY）
    for (const [k, v] of Object.entries(loadDotEnv(dshHome))) {
      if (!(k in env)) env[k] = v;
    }
    // 注入本次登录提供的额外环境变量（DEEPSEEK_API_KEY 或 CUSTOM_API_KEY 等）
    for (const [k, v] of Object.entries(extraEnv || {})) {
      env[k] = v;
    }

    // 注意：--patch 是 launcher 参数，必须放在 --profile 之前；
    // 放在之后会被当作 web app 参数而报 unknown option '--patch'。
    const args = [DSH_BIN];
    if (modelPatch) args.push('--patch', modelPatch);
    args.push('--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0');

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

/**
 * 科幻主题 CSS：通过覆盖 dsh 的 --dsw-* 主题变量，把主界面品牌色调成
 * 霓虹蓝（#00d4ff）/ 电光紫（#8b5cf6），与登录页/加载页保持视觉统一。
 * 只覆盖颜色 token，不改动 dsh 的布局与结构。
 */
const SCI_FI_THEME_CSS = `
  :root, body {
    --dsw-alias-brand-primary: #3b82f6;
    --dsw-alias-brand-primary-invert: #0a1020;
    --dsw-alias-button-primary-fill: #2563eb;
    --dsw-alias-button-primary-hover: #3b82f6;
    --dsw-alias-button-primary-dimmed: #1e40af;
    --dsw-alias-state-business-primary: #3b82f6;
    --dsw-alias-state-business-tertiary: #60a5fa;
    --dsw-alias-onboarding-accent: #3b82f6;
    --dsw-alias-interactive-bg-hover-accent: rgba(59, 130, 246, 0.12);
    --dsw-focus-ring-color: #3b82f6;
    --dsw-alias-label-primary-bluish: #93c5fd;
  }
`;

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

  // 每次页面加载完成后注入科幻主题（登录页无影响，dsh 主界面生效）
  mainWindow.webContents.on('did-finish-load', () => {
    try { mainWindow.webContents.insertCSS(SCI_FI_THEME_CSS); } catch (_) {}
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/i.test(u)) shell.openExternal(u);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

/* ---------------- IPC ---------------- */

ipcMain.handle('dsh:get-config', () => {
  const username = getLastUser();
  const dshHome = resolveDshHome(username);
  const cfg = loadAppConfig(dshHome);
  const env = loadDotEnv(dshHome);
  const hasKey = !!(env.DEEPSEEK_API_KEY || env.CUSTOM_API_KEY);
  return {
    username: cfg.username || username,
    model: cfg.model || 'deepseek-v4-pro',
    providerType: cfg.providerType || 'deepseek',
    baseURL: cfg.baseURL || '',
    hasKey,
  };
});

ipcMain.handle('dsh:open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
});

/** 执行登录（验证 → 保存 → 启动 dsh），返回 { ok, url } 或 { ok, error }。供 IPC 与自动登录复用 */
async function performLogin(payload) {
  const username = String((payload && payload.username) || '').trim();
  const providerType = String((payload && payload.providerType) || 'deepseek');
  const apiKey = String((payload && payload.apiKey) || '').trim();
  if (!username) return { ok: false, error: '用户名不能为空' };
  const dshHome = resolveDshHome(username);

  // 自定义 OpenAI 兼容模型
  if (providerType === 'custom') {
    const baseURL = String((payload && payload.baseURL) || '').trim();
    const modelId = String((payload && payload.modelId) || '').trim();
    if (!baseURL) return { ok: false, error: '请填写 Base URL' };
    if (!modelId) return { ok: false, error: '请填写模型 ID' };
    const keyToUse = apiKey || loadDotEnv(dshHome).CUSTOM_API_KEY || '';
    if (!keyToUse) return { ok: false, error: '请填写 API Key' };
    log('[login] 校验自定义模型，用户 =', username, '，baseURL =', baseURL);
    const v = await verifyApiKey(keyToUse, baseURL);
    if (!v.ok) return v;
    saveDotEnvKey(dshHome, 'CUSTOM_API_KEY', keyToUse);
    saveAppConfig(dshHome, { username, model: modelId, providerType: 'custom', baseURL });
    saveLastUser(username);
    const url = await startDsh(buildCustomPatch(baseURL, modelId), { CUSTOM_API_KEY: keyToUse }, username);
    return { ok: true, url };
  }

  // DeepSeek 官方模型
  const model = String((payload && payload.model) || 'deepseek-v4-pro').trim();
  const keyToUse = apiKey || loadDotEnv(dshHome).DEEPSEEK_API_KEY || '';
  if (!keyToUse) return { ok: false, error: '请填写 API Key' };
  log('[login] 校验 API Key，用户 =', username, '，模型 =', model);
  const v = await verifyApiKey(keyToUse);
  if (!v.ok) return v;
  saveDotEnvKey(dshHome, 'DEEPSEEK_API_KEY', keyToUse);
  saveAppConfig(dshHome, { username, model });
  saveLastUser(username);
  const url = await startDsh(buildDeepSeekPatch(model), { DEEPSEEK_API_KEY: keyToUse }, username);
  return { ok: true, url };
}

ipcMain.handle('dsh:login', async (_e, payload) => {
  try {
    const res = await performLogin(payload);
    if (res.ok) {
      if (mainWindow) {
        mainWindow.setTitle('DeepSeek Harness — ' + sanitizeUsername(payload.username));
        mainWindow.loadURL(res.url); // 主进程导航，确保 token cookie 正确写入
      }
      return { ok: true };
    }
    return res;
  } catch (err) {
    log('[login] 登录异常：', err.message);
    return { ok: false, error: '登录失败：' + err.message };
  }
});

/* ---------------- 生命周期 ---------------- */

app.whenReady().then(async () => {
  log('====== DeepSeek Harness (Intel) 启动 ======');
  log('[env] arch =', process.arch, ', platform =', process.platform, ', electron =', process.versions.electron);
  createWindow();

  // 自动登录：若上次登录的用户与其 Key 已保存，直接启动 dsh 进入主界面
  const lastUser = getLastUser();
  if (lastUser) {
    const dshHome = resolveDshHome(lastUser);
    const cfg = loadAppConfig(dshHome);
    const env = loadDotEnv(dshHome);
    const hasKey = !!(env.DEEPSEEK_API_KEY || env.CUSTOM_API_KEY);
    if (cfg.username && hasKey) {
      log('[auto-login] 自动登录用户 =', lastUser);
      try {
        const res = await performLogin({
          username: lastUser,
          providerType: cfg.providerType || 'deepseek',
          model: cfg.model || 'deepseek-v4-pro',
          modelId: cfg.model,
          baseURL: cfg.baseURL || '',
        });
        if (res.ok && mainWindow) {
          mainWindow.setTitle('DeepSeek Harness — ' + sanitizeUsername(lastUser));
          mainWindow.loadURL(res.url);
        }
      } catch (err) {
        log('[auto-login] 自动登录失败：', err.message);
      }
    }
  }
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
