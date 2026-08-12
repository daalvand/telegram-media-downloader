const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const Store = require('./store');
const appConfig = require('./appConfig');
const tg = require('./telegramClient');

let mainWindow;
let pendingPhone = null;
let pendingPhoneCodeHash = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function errCode(err) {
  const msg = err?.errorMessage || err?.message || String(err);
  if (msg.includes('PHONE_CODE_INVALID')) return 'wrong_code';
  if (msg.includes('PASSWORD_HASH_INVALID')) return 'wrong_password';
  if (msg.includes('FLOOD_WAIT')) return 'flood_wait';
  if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('ENOTFOUND')) {
    return 'proxy_unreachable';
  }
  return 'unknown';
}

const ALLOWED_EXTERNAL_LINKS = new Set(['https://my.telegram.org/apps']);

ipcMain.handle('shell:openExternal', (_e, url) => {
  if (ALLOWED_EXTERNAL_LINKS.has(url)) shell.openExternal(url);
});

ipcMain.handle('appConfig:get', () => {
  return { configured: appConfig.isConfigured(), config: appConfig.get() };
});

ipcMain.handle('appConfig:set', (_e, { apiId, apiHash, proxyEnabled, proxyType, proxyHost, proxyPort }) => {
  try {
    const saved = appConfig.set({ apiId, apiHash, proxyEnabled, proxyType, proxyHost, proxyPort });
    return { ok: true, config: saved };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('session:restore', async () => {
  try {
    const loggedIn = await tg.restoreSession();
    return { loggedIn };
  } catch (err) {
    return { loggedIn: false, error: errCode(err) };
  }
});

ipcMain.handle('login:sendCode', async (_e, phone) => {
  try {
    pendingPhone = phone;
    pendingPhoneCodeHash = await tg.sendCode(phone);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errCode(err) };
  }
});

ipcMain.handle('login:verify', async (_e, code) => {
  try {
    const result = await tg.verifyCode(pendingPhone, pendingPhoneCodeHash, code);
    return { ok: true, needsPassword: result.needsPassword };
  } catch (err) {
    return { ok: false, error: errCode(err) };
  }
});

ipcMain.handle('login:verifyPassword', async (_e, password) => {
  try {
    await tg.verifyPassword(password);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errCode(err) };
  }
});

ipcMain.handle('session:logout', async () => {
  await tg.logout();
  return { ok: true };
});

ipcMain.handle('chats:list', async () => {
  try {
    return { ok: true, chats: await tg.listChats() };
  } catch (err) {
    return { ok: false, error: errCode(err) };
  }
});

ipcMain.handle('media:list', async (_e, { chatId, filter, offsetId }) => {
  try {
    const result = await tg.listMediaBatch(chatId, filter, offsetId);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: errCode(err) };
  }
});

ipcMain.handle('settings:chooseFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return { ok: false };
  Store.set('downloadFolder', result.filePaths[0]);
  return { ok: true, folder: result.filePaths[0] };
});

ipcMain.handle('settings:get', () => {
  const cfg = appConfig.get() || {};
  return {
    downloadFolder: Store.get('downloadFolder') || null,
    proxyHost: cfg.proxyHost,
    proxyPort: cfg.proxyPort,
  };
});

ipcMain.handle('media:download', async (event, { chatId, messageIds, destFolder }) => {
  const results = [];
  for (const messageId of messageIds) {
    try {
      await tg.downloadOne(chatId, messageId, destFolder, (percent) => {
        mainWindow.webContents.send('download:progress', { messageId, percent });
      });
      mainWindow.webContents.send('download:done', { messageId, ok: true });
      results.push({ messageId, ok: true });
    } catch (err) {
      mainWindow.webContents.send('download:done', {
        messageId,
        ok: false,
        error: err.message,
      });
      results.push({ messageId, ok: false, error: err.message });
    }
  }
  return { ok: true, results };
});
