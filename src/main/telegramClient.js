const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram');
const path = require('path');
const fs = require('fs');
const { safeStorage, app } = require('electron');
const appConfig = require('./appConfig');

const SESSION_FILE = () => path.join(app.getPath('userData'), 'session.enc');

function saveSession(sessionString) {
  const dir = path.dirname(SESSION_FILE());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const encrypted = safeStorage.encryptString(sessionString);
  fs.writeFileSync(SESSION_FILE(), encrypted);
}

function loadSession() {
  if (!fs.existsSync(SESSION_FILE())) return '';
  try {
    const encrypted = fs.readFileSync(SESSION_FILE());
    return safeStorage.decryptString(encrypted);
  } catch {
    return '';
  }
}

function clearSession() {
  if (fs.existsSync(SESSION_FILE())) fs.unlinkSync(SESSION_FILE());
}

let client = null;

function getClient() {
  if (client) return client;
  const cfg = appConfig.get();
  if (!cfg || !cfg.apiId || !cfg.apiHash) {
    throw new Error('App is not configured yet (missing api_id/api_hash)');
  }
  const session = new StringSession(loadSession());
  const options = { connectionRetries: 5 };
  if (cfg.proxyEnabled) {
    options.proxy = {
      socksType: cfg.proxyType === 'socks4' ? 4 : 5,
      ip: cfg.proxyHost,
      port: cfg.proxyPort,
    };
  }
  client = new TelegramClient(session, cfg.apiId, cfg.apiHash, options);
  return client;
}

async function restoreSession() {
  const c = getClient();
  const existing = loadSession();
  if (!existing) return false;
  try {
    await c.connect();
    const me = await c.getMe();
    return !!me;
  } catch {
    return false;
  }
}

async function sendCode(phone) {
  const c = getClient();
  const cfg = appConfig.get();
  await c.connect();
  const result = await c.sendCode(
    { apiId: cfg.apiId, apiHash: cfg.apiHash },
    phone
  );
  return result.phoneCodeHash;
}

async function verifyCode(phone, phoneCodeHash, code) {
  const c = getClient();
  try {
    await c.invoke(
      new Api.auth.SignIn({
        phoneNumber: phone,
        phoneCodeHash,
        phoneCode: code,
      })
    );
  } catch (err) {
    if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
      return { needsPassword: true };
    }
    throw err;
  }
  saveSession(c.session.save());
  return { needsPassword: false };
}

async function verifyPassword(password) {
  const c = getClient();
  const cfg = appConfig.get();
  await c.signInWithPassword(
    { apiId: cfg.apiId, apiHash: cfg.apiHash },
    {
      password: async () => password,
      onError: (err) => {
        throw err;
      },
    }
  );
  saveSession(c.session.save());
}

async function logout() {
  const c = getClient();
  try {
    await c.invoke(new Api.auth.LogOut());
  } catch {
    // ignore - clear local state regardless
  }
  clearSession();
  client = null;
}

async function listChats() {
  const c = getClient();
  const dialogs = await c.getDialogs({ limit: 200 });
  return dialogs.map((d) => ({
    id: d.id.toString(),
    name: d.title || d.name || 'Unknown',
    type: d.isChannel ? 'channel' : d.isGroup ? 'group' : 'user',
    unreadCount: d.unreadCount || 0,
  }));
}

const MEDIA_FILTERS = {
  photo: Api.InputMessagesFilterPhotos,
  video: Api.InputMessagesFilterVideo,
  gif: Api.InputMessagesFilterGif,
  voice: Api.InputMessagesFilterVoice,
  video_note: Api.InputMessagesFilterRoundVideo,
  document: Api.InputMessagesFilterDocument,
};

function classify(message) {
  if (!message.media) return null;
  if (message.gif) return 'gif';
  if (message.voice) return 'voice';
  if (message.videoNote) return 'video_note';
  if (message.video) return 'video';
  if (message.photo) return 'photo';
  if (message.sticker) return 'sticker';
  if (message.document) return 'document';
  return null;
}

const MIME_EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
};

const DEFAULT_EXTENSIONS = {
  photo: 'jpg',
  voice: 'ogg',
  video_note: 'mp4',
  video: 'mp4',
  gif: 'mp4',
  sticker: 'webp',
  document: 'bin',
};

function extensionFromMime(mimeType) {
  if (!mimeType) return null;
  if (MIME_EXTENSIONS[mimeType]) return MIME_EXTENSIONS[mimeType];
  const subtype = mimeType.split('/')[1];
  return subtype ? subtype.split('+')[0] : null;
}

function filenameFor(message, type) {
  const explicit = message.document?.attributes?.find((a) => a.fileName)?.fileName;
  if (explicit) return explicit;
  const ext =
    extensionFromMime(message.document?.mimeType) || DEFAULT_EXTENSIONS[type] || 'bin';
  return `${type}_${message.id}.${ext}`;
}

function sniffImageMime(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF') return 'image/webp';
  return 'image/jpeg';
}

const NO_THUMB_TYPES = new Set(['voice']);

async function getThumbnailDataUri(c, message, type) {
  if (NO_THUMB_TYPES.has(type)) return null;
  try {
    const buf = await c.downloadMedia(message, { thumb: -1 });
    if (!buf || !buf.length) return null;
    return `data:${sniffImageMime(buf)};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

async function listMediaBatch(chatId, filterKey, offsetId) {
  const c = getClient();
  const filterClass = MEDIA_FILTERS[filterKey];
  const params = { limit: 50, offsetId: offsetId || 0 };
  if (filterClass) params.filter = new filterClass({});

  const messages = await c.getMessages(chatId, params);
  const items = (
    await Promise.all(
      messages.map(async (m) => {
        const type = classify(m);
        if (!type) return null;
        const filename = filenameFor(m, type);
        const size = m.document?.size ? Number(m.document.size) : null;
        const caption = m.message ? m.message.slice(0, 140) : '';
        const thumbnail = await getThumbnailDataUri(c, m, type);
        return {
          id: m.id,
          type,
          filename,
          size,
          date: m.date ? m.date * 1000 : null,
          caption,
          thumbnail,
        };
      })
    )
  ).filter(Boolean);

  const lastId = messages.length ? messages[messages.length - 1].id : null;
  return { items, done: messages.length < 50, nextOffsetId: lastId };
}

async function downloadOne(chatId, messageId, destFolder, onProgress) {
  const c = getClient();
  const [message] = await c.getMessages(chatId, { ids: [messageId] });
  if (!message || !message.media) {
    throw new Error('Media not found (may have been deleted)');
  }
  const type = classify(message);
  const filename = filenameFor(message, type);
  const destPath = path.join(destFolder, filename);

  const buffer = await c.downloadMedia(message, {
    progressCallback: (received, total) => {
      if (total) onProgress(Math.round((Number(received) / Number(total)) * 100));
    },
  });
  fs.writeFileSync(destPath, buffer);
  return destPath;
}

module.exports = {
  restoreSession,
  sendCode,
  verifyCode,
  verifyPassword,
  logout,
  listChats,
  listMediaBatch,
  downloadOne,
};
