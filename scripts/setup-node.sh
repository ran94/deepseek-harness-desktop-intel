#!/usr/bin/env bash
# 下载官方 Node 24（darwin-x64）运行时到 runtime/，供 electron-builder 打包进应用。
# dsh 依赖多项 Node 24 特性，系统 Node 22 不满足，故需要内置 Node 24。
set -euo pipefail

NODE_VERSION="v24.22.2"
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
