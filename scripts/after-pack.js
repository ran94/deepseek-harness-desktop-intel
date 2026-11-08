'use strict';

// electron-builder afterPack 钩子：裁剪 app 体积。
// 删除核心功能（Web 聊天 + 模型调用）不需要的大文件，均为 lazy 加载或非 web profile 组件。

const path = require('path');
const fs = require('fs');

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

module.exports = async function afterPack(context) {
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  const nm = path.join(appPath, 'Contents', 'Resources', 'app', 'node_modules');

  // 1. LibreOffice 二进制（仅 Office 转 PDF 用到，~155M；核心聊天不需要，lazy 加载）
  rmrf(path.join(nm, '@deepseek-ai', 'libreoffice-kit-darwin-x64', 'bin'));
  rmrf(path.join(nm, '@deepseek-ai', 'libreoffice-kit-darwin-x64', 'program'));

  // 2. 语音识别库（web profile 不加载，~36M）
  rmrf(path.join(nm, 'sherpa-onnx-darwin-x64'));

  // 3. Electron 多余 locale（保留英文 + 简繁中文，其余删除，~20M）
  const res = path.join(appPath, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources');
  const keep = new Set(['en.lproj', 'en_GB.lproj', 'zh_CN.lproj', 'zh_TW.lproj']);
  try {
    for (const e of fs.readdirSync(res)) {
      if (e.endsWith('.lproj') && !keep.has(e)) rmrf(path.join(res, e));
    }
  } catch (_) { /* ignore */ }

  // 统计裁剪后的体积
  let total = 0;
  try {
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else { try { total += fs.statSync(p).size; } catch (_) {} }
      }
    };
    walk(appPath);
  } catch (_) { /* ignore */ }
  console.log(`[after-pack] 体积裁剪完成，app 约 ${(total / 1024 / 1024 / 1024).toFixed(2)} GB`);
};
