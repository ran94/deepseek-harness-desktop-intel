'use strict';

// preload：通过 contextBridge 暴露最小、安全的主进程接口给启动页。
// 不注入 Node 能力到渲染进程，保持 sandbox + contextIsolation 安全隔离。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshDesktop', {
  platform: process.platform,
  arch: process.arch,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  },

  // 登录：验证 API Key → 保存配置 → 启动 dsh → 返回 dsh web 地址
  login: (payload) => ipcRenderer.invoke('dsh:login', payload),

  // 读取已保存的启动配置（用户名、模型；不含 API Key）
  getConfig: () => ipcRenderer.invoke('dsh:get-config'),

  // 打开外链（如 DeepSeek 开放平台）
  openExternal: (url) => ipcRenderer.invoke('dsh:open-external', url),

  // 启动动画播放完毕后，通知主进程跳转到 dsh 主界面
  navigate: () => ipcRenderer.invoke('dsh:navigate'),
});
