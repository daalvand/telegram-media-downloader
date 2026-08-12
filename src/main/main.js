const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const Store = require('./store');
const appConfig = require('./appConfig');
const tg = require('./telegramClient');

let mainWindow;
let pendingPhone = null;
let pendingPhoneCodeHash = null;

// GramJS runs an internal ping/update loop as a fire-and-forget promise
// (TelegramClient.js calls `_updateLoop(this)` without awaiting or catching
// it). If the connection drops mid-loop, that rejection is unhandled, and
// Node's default behavior for an unhandled rejection is to crash the whole
// process. These handlers are the safety net that keeps the app alive
// instead of dying every time the network blips.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

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

const CONNECTION_ERROR_PATTERNS = [
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'timed out',
  'timeout',
  'not connected',
  'connection closed',
  'socksclienterror',
  'proxy connection',
  'disconnected',
  'econnaborted',
];

function errCode(err) {
  const msg = (err?.errorMessage || err?.message || String(err) || '').toLowerCase();
  if (msg.includes('phone_code_invalid')) return 'wrong_code';
  if (msg.includes('password_hash_invalid')) return 'wrong_password';
  if (msg.includes('flood_wait')) return 'flood_wait';
  if (CONNECTION_ERROR_PATTERNS.some((p) => msg.includes(p))) return 'connection_error';
  return 'unknown';
}

const ALLOWED_EXTERNAL_LINKS = new Set(['https://my.telegram.org/apps']);

ipcMain.handle('shell:openExternal', (_e, url) => {
  if (ALLOWED_EXTERNAL_LINKS.has(url)) shell.openExternal(url);
});

function buildTelegramMessageUrl(chatId, chatType, messageId) {
  const id = String(chatId);
  if (!/^-?\d+$/.test(id) || !Number.isInteger(messageId) || messageId <= 0) return null;
  if (chatType === 'user') {
    return `tg://openmessage?user_id=${id}&message_id=${messageId}`;
  }
  if (chatType === 'channel') {
    const internalId = id.replace(/^-100/, '');
    if (!/^\d+$/.test(internalId)) return null;
    return `tg://privatepost?channel=${internalId}&post=${messageId}`;
  }
  const positiveId = Math.abs(Number(id));
  return `tg://openmessage?chat_id=${positiveId}&message_id=${messageId}`;
}

ipcMain.handle('telegram:openMessage', (_e, { chatId, chatType, messageId }) => {
  const url = buildTelegramMessageUrl(chatId, chatType, messageId);
  if (url) shell.openExternal(url);
  return { ok: !!url };
});

ipcMain.handle('appConfig:get', () => {
  return { configured: appConfig.isConfigured(), config: appConfig.get() };
});

ipcMain.handle('appConfig:set', (_e, { apiId, apiHash, proxyEnabled, proxyType, proxyHost, proxyPort }) => {
  try {
    const saved = appConfig.set({ apiId, apiHash, proxyEnabled, proxyType, proxyHost, proxyPort });
    // The GramJS client is built once from the config it saw at construction
    // time; force a rebuild so changed proxy/API settings actually take effect.
    tg.resetClient();
    return { ok: true, config: saved };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('session:restore', async () => {
  try {
    const result = await tg.restoreSession();
    if (result.loggedIn) return { loggedIn: true };
    if (result.reason === 'connection_failed') {
      return { loggedIn: false, reason: 'connection_failed', error: errCode(result.error || {}) };
    }
    return { loggedIn: false, reason: 'no_session' };
  } catch (err) {
    return { loggedIn: false, reason: 'connection_failed', error: errCode(err) };
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
    const result = await tg.listMediaBatch(chatId, filter, offsetId, (id, thumbnail) => {
      mainWindow.webContents.send('media:thumbnail', { id, thumbnail });
    });
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
