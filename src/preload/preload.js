const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tg', {
  getAppConfig: () => ipcRenderer.invoke('appConfig:get'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  openTelegramMessage: (chatId, chatType, messageId) =>
    ipcRenderer.invoke('telegram:openMessage', { chatId, chatType, messageId }),
  setAppConfig: (config) => ipcRenderer.invoke('appConfig:set', config),
  restoreSession: () => ipcRenderer.invoke('session:restore'),
  sendCode: (phone) => ipcRenderer.invoke('login:sendCode', phone),
  verify: (code) => ipcRenderer.invoke('login:verify', code),
  verifyPassword: (password) => ipcRenderer.invoke('login:verifyPassword', password),
  logout: () => ipcRenderer.invoke('session:logout'),
  listChats: () => ipcRenderer.invoke('chats:list'),
  listMedia: (chatId, filter, offsetId) =>
    ipcRenderer.invoke('media:list', { chatId, filter, offsetId }),
  download: (chatId, messageIds, destFolder) =>
    ipcRenderer.invoke('media:download', { chatId, messageIds, destFolder }),
  chooseFolder: () => ipcRenderer.invoke('settings:chooseFolder'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  onDownloadProgress: (cb) =>
    ipcRenderer.on('download:progress', (_e, data) => cb(data)),
  onDownloadDone: (cb) => ipcRenderer.on('download:done', (_e, data) => cb(data)),
  onMediaThumbnail: (cb) => ipcRenderer.on('media:thumbnail', (_e, data) => cb(data)),
});
