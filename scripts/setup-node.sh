#!/usr/bin/env bash
# 下载官方 Node 22 LTS（darwin-x64）运行时到 runtime/，供 electron-builder 打包进应用。
# 为什么是 Node 22 而非 24：
#   - dsh 的 JS 依赖 import.meta.main / node:zlib zstd 等特性（Node 22.19+ 已回移植）；
#   - dsh 的原生模块 node-addon-require-builtin 的 prebuilt 是 NAPI v9（Node 22 ABI），
#     与 Node 24 的 NAPI v10 不兼容（符号 _napi_create_error 缺失）。
#   - 因此必须用 Node 22 LTS 最新版（>=22.19），同时满足 JS 特性与原生 ABI。
set -euo pipefail

NODE_VERSION="v22.23.4"
NODE_DIST="node-${NODE_VERSION}-darwin-x64"
NODE_TARBALL="${NODE_DIST}.tar.gz"
# 优先使用 npmmirror 镜像（中国大陆加速）；如需官方源可改为 https://nodejs.org/dist/${NODE_VERSION}
BASE_URL="https://npmmirror.com/mirrors/node/${NODE_VERSION}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_DIR="${ROOT}/runtime"
NODE_BIN="${RUNTIME_DIR}/${NODE_DIST}/bin/node"

if [ -x "${NODE_BIN}" ]; then
  echo "Node 运行时已存在：${NODE_BIN}"
  "${NODE_BIN}" --version
  exit 0
fi

mkdir -p "${RUNTIME_DIR}"
echo "下载 ${NODE_VERSION} (darwin-x64) ..."
curl -fSL --retry 3 -o "/tmp/${NODE_TARBALL}" "${BASE_URL}/${NODE_TARBALL}"

echo "解压到 runtime/ ..."
tar -xzf "/tmp/${NODE_TARBALL}" -C "${RUNTIME_DIR}"
rm -f "/tmp/${NODE_TARBALL}"

echo "精简运行时（dsh 仅需 bin/node）..."
rm -rf "${RUNTIME_DIR}/${NODE_DIST}/include" \
       "${RUNTIME_DIR}/${NODE_DIST}/lib" \
       "${RUNTIME_DIR}/${NODE_DIST}/share" \
       "${RUNTIME_DIR}/${NODE_DIST}/CHANGELOG.md" \
       "${RUNTIME_DIR}/${NODE_DIST}/README.md" \
       "${RUNTIME_DIR}/${NODE_DIST}/LICENSE" \
       "${RUNTIME_DIR}/${NODE_DIST}/bin/npm" \
       "${RUNTIME_DIR}/${NODE_DIST}/bin/npx" \
       "${RUNTIME_DIR}/${NODE_DIST}/bin/corepack"

echo "完成：${NODE_BIN}"
"${NODE_BIN}" --version
