# DeepSeek Harness 桌面客户端 —— Intel (x64) macOS 适配版

把 DeepSeek 官方智能体平台 **DeepSeek Harness（`@deepseek-ai/dsh`）** 做成可在
**Intel 芯片 MacBook Pro（x86_64）** 上稳定运行的桌面应用。

官方桌面版只发布了 **Apple Silicon (arm64) + Windows x64**，没有 Intel macOS 版。
本项目补齐这一缺口：Electron 宿主 + 内置官方 Node 24 运行时 + dsh 官方 npm 包，
全部构建为 **x86_64**。

---

## 1. 成果概览

- 产物：`dist/mac/DeepSeek Harness.app`（约 1.0 GB，含完整运行时，双击即用）
- 已验证：应用启动 → 内置 Node 24 拉起 dsh → 解析带 token 的启动 URL → Electron
  窗口加载本地回环页面（日志见 `dsh-desktop.log` 的 `[web] 页面加载完成`）
- 本机环境：macOS 13.7.8 (Ventura)、Intel Core i7-7567U、MacBookPro14,2、16GB

---

## 2. 架构

```
┌─────────────────────────────── DeepSeek Harness.app ───────────────────────────────┐
│  Electron 主进程 (main.js, x64)                                                      │
│    1. 找到内置 Node 24 → 清理陈旧锁 → spawn dsh                                     │
│    2. 解析 stdout 中的 "dsh web: http://127.0.0.1:PORT/?token=..."                  │
│    3. BrowserWindow.loadURL(token URL) → 同源回环，零 CORS/零鉴权改造                 │
│                                                                                      │
│  Resources/node-runtime/bin/node   ← 官方 Node v24.22.2 darwin-x64（内置）            │
│  Resources/app/node_modules/@deepseek-ai/dsh/**  ← 官方 npm 包（生产依赖，未走 asar）│
└──────────────────────────────────────────────────────────────────────────────────────┘
```

要点：
- **不 fork、不套壳**：直接运行官方 dsh 的 `bin.js --profile web --no-open`，核心零改动。
- `--no-open`：不让 dsh 弹系统浏览器，改由 Electron 窗口承载。
- `--port 0`：让系统挑空闲端口，`main.js` 从 stdout 解析真实地址，避免端口冲突。
- `asar: false`：dsh 的 `bin.js` 及依赖必须以真实文件存在，才能被外部 node 进程运行
  （asar 是 Electron 私有归档格式，外部 node 读不了）。

---

## 3. 为什么必须做 Intel 适配（对比 Apple Silicon）

| 维度 | Apple Silicon（官方版） | Intel macOS（本适配版） |
|---|---|---|
| CPU 架构 | arm64 | **x86_64** |
| Electron | darwin-arm64 | **darwin-x64** |
| Node 运行时 | 内置 arm64 Node | **内置 x64 Node 24** |
| dsh 原生依赖 | arm64 二进制（如 `sherpa-onnx-darwin-arm64`） | **`sherpa-onnx-darwin-x64`**（75MB 语音/ML 原生库，随 npm 自动装 x64 版） |

dsh 的 npm 包本身是纯 JS（无 `os`/`cpu` 平台锁），会按当前平台自动装对应的原生可选依赖；
在 Intel 机上 `npm install` 拉到的就是 `*-darwin-x64` 二进制。真正需要手工适配的是**宿主层**
（Electron + Node 运行时 + 打包目标架构）。

---

## 4. 关键技术决策（踩坑记录）

### 4.1 dsh 需要 Node 24 特性，系统 Node 22 不够
`dsh` 的代码用了多项 **Node 24** 能力，系统自带的 Node 22.11 会直接静默失败：
- `import.meta.main`（bin.js 入口判断，Node 22 里为 `undefined` → CLI 不执行）
- `node:zlib.createZstdCompress` / `node:util.getSystemErrorMessage` /
  `node:module.stripTypeScriptTypes`（插件 import 时 `SyntaxError`）

→ **方案：把官方 Node v24.22.2（darwin-x64，LTS "Krypton"）打包进 app**，运行时用它跑 dsh。

### 4.2 宿主的 Node 拦截 shim 会让 dsh 挂起
某些开发环境通过 `NODE_OPTIONS` 注入 fs 拦截 shim，被 dsh 子进程继承后会在插件加载阶段
**静默挂起**（无任何输出）。
→ `main.js` 在 spawn dsh 时**强制清空 `NODE_OPTIONS=''`**。

### 4.3 dsh 原子写锁残留导致启动失败
dsh 用 `dsh-atomic-write` 以 `wx` 标志创建 `.credentials.yaml.lock`，进程被强杀会残留锁，
下次启动在 `connection` 插件处报 `EPERM unlink .credentials.yaml.lock` 或等锁超时。
→ `main.js` 启动前**清理陈旧的凭据锁文件**；退出时先 `SIGINT` 给 dsh 释放锁的机会。

### 4.4 Intel 老机型启动慢
dsh 首次启动要加载数百个 Cordis 插件，i7-7567U 上约 20~60 秒（后续启动更快）。
→ 就绪超时设为 **180 秒**，避免误杀 dsh。

---

## 5. 完整构建步骤（在本机复现）

```bash
cd /Users/ranbi/Desktop/DSforINTEl

# 0) 前置：Node ≥ 18（用系统 node/npm 即可，仅用于安装依赖与打包）
node -v && npm -v

# 1) 下载并解压官方 Node 24 darwin-x64（作为应用内置运行时）
curl -sL -o /tmp/node.tar.gz \
  https://npmmirror.com/mirrors/node/v24.22.2/node-v24.22.2-darwin-x64.tar.gz
mkdir -p runtime && tar -xzf /tmp/node.tar.gz -C runtime/
#   → 得到 runtime/node-v24.22.2-darwin-x64/

# 2) 安装依赖（含 dsh 与 Electron；走国内镜像，见 .npmrc）
npm install --no-audit --no-fund

# 3) 打包（darwin-x64 的 .app，跳过签名，本地自用）
npm run pack
#   → 产物 dist/mac/DeepSeek Harness.app
```

`.npmrc`（已配置国内镜像，加速 Electron 二进制与依赖下载）：
```
registry=https://registry.npmmirror.com
electron_mirror=https://npmmirror.com/mirrors/electron/
electron_builder_binaries_mirror=https://npmmirror.com/mirrors/electron-builder-binaries/
```

> 说明：本机 npm 缓存目录曾有 root 属主文件导致 `EPERM`，故项目内用独立缓存
> `--cache` 或 `.npmrc` 里的 `cache=` 指向可写目录即可规避。

---

## 6. 运行与配置

```bash
# 直接双击，或用命令行启动：
open "dist/mac/DeepSeek Harness.app"
```

- **首次打开**：若提示「无法验证开发者」，右键 → 打开 → 打开（本地构建、未签名所致；
  正式分发时用 Developer ID 证书签名 + 公证即可）。
- **数据目录**：默认 `~/.dsh`（与命令行 `dsh web` 共享配置）；可用环境变量 `DSH_HOME` 覆盖。
- **模型 API Key**：打开应用后进入 **设置 → Models**，填入 DeepSeek 的 `DEEPSEEK_API_KEY`，
  默认模型为 `deepseek-official` / `deepseek-flash`（DeepSeek-V4.1-Flash）。
- **日志**：`~/Library/Application Support/deepseek-harness-desktop-intel/dsh-desktop.log`

---

## 7. 目录结构

```
DSforINTEl/
├── main.js                  # Electron 主进程：拉起 dsh、解析 URL、开窗口
├── preload.js               # 预留 preload（安全隔离，无特权注入）
├── package.json             # 依赖 + electron-builder 打包配置
├── .npmrc                   # 国内镜像 + 独立缓存
├── runtime/node-v24.22.2-darwin-x64/   # 内置 Node 24 运行时（打包进 app）
├── scripts/
│   ├── icon_gen.py          # 生成应用图标（PIL）
│   └── dsh-runner.mjs       # （可选）绕过 import.meta.main 的启动器
└── dist/mac/DeepSeek Harness.app        # 最终产物
```

---

## 8. 已知限制 / 可选优化

- **体积**：约 1.0 GB（Electron ~200MB + dsh 依赖 ~512MB + Node 24 ~200MB）。可进一步：
  - `strip` 内置 node 二进制（120MB→约 50MB）；
  - 删除 Electron 多余 locale（约省 100MB）；
  - 用 `asar` + `asarUnpack` 只解包 dsh 运行时必需文件。
- **未签名**：本地自用无碍；分发需 Apple Developer ID 签名 + notarization。
- **老机型**：首次启动需等待 dsh 加载插件（约 20~60 秒），属正常现象。
