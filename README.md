# DeepSeek Harness 桌面客户端（Intel macOS 版）

将 DeepSeek 官方智能体平台 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`@deepseek-ai/dsh`）
封装为可在 **Intel 芯片 MacBook Pro（x86_64）** 上稳定运行的桌面应用。

> 官方桌面版仅发布 Apple Silicon (arm64) 与 Windows x64，本项目补齐 **Intel macOS** 缺口。

## 特性

- 双击即用的原生桌面窗口，无需终端
- 内置官方 Node 22 LTS 运行时与官方 dsh 包，完全离线可运行
- 零架构改动：不 fork、不套壳，直接运行官方 `dsh --profile web`
- 与命令行 `dsh` 共享配置（默认数据目录 `~/.dsh`）

## 系统要求

- macOS（Intel x86_64，如 2017 及以后的 Intel MacBook Pro）
- Node.js ≥ 18（仅用于本地构建，运行时无需）
- 构建时需要网络下载依赖

## 快速开始

```bash
# 1. 配置镜像（中国大陆用户加速，可选）
cp .npmrc.example .npmrc

# 2. 安装依赖
npm install

# 3. 下载 Node 22 LTS 运行时并打包（一条命令，自动完成）
npm run pack

# 产物：dist/mac/DeepSeek Harness.app
```

也可以手动分步执行：

```bash
npm run setup    # 下载 Node 22 LTS darwin-x64 到 runtime/
npm run pack     # electron-builder 打包为 .app
```

## 运行

```bash
open "dist/mac/DeepSeek Harness.app"
```

- 首次打开若提示「无法验证开发者」，右键 → 打开（本地构建未签名；正式分发需 Developer ID 签名 + 公证）。
- 打开后进入 **设置 → Models** 填入 DeepSeek 的 `DEEPSEEK_API_KEY`。

## 目录结构

```
├── main.js              # Electron 主进程：拉起 dsh、解析启动 URL、开窗口
├── preload.js           # preload（安全隔离）
├── package.json         # 依赖与 electron-builder 打包配置
├── scripts/
│   ├── setup-node.sh    # 下载 Node 22 LTS darwin-x64 到 runtime/
│   ├── icon_gen.py      # 生成应用图标
│   └── dsh-runner.mjs   # （可选）绕过 import.meta.main 的启动器
├── build/icon.png       # 应用图标
└── BUILD.md             # 详细架构说明与踩坑记录
```

## 工作原理

Electron 宿主 → 内置 Node 22 LTS 运行 `dsh --profile web --no-open --port 0` → 从 stdout
解析带 token 的启动 URL → BrowserWindow 加载本地回环地址（同源、零 CORS/鉴权改造）。

详见 [BUILD.md](./BUILD.md)。

## 许可证

[MIT](./LICENSE)
