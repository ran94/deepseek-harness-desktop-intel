'use strict';

// 预留 preload：当前架构无需向渲染进程注入任何特权能力。
// 保持 contextIsolation: true + sandbox: true，保证 Web 前端安全隔离。
// 若后续需要托盘、通知、剪贴板等桌面能力，可在此通过 contextBridge 暴露最小接口。

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('dshDesktop', {
  platform: process.platform,
  arch: process.arch,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  },
});
