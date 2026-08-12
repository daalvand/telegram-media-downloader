const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram');
const bigInt = require('big-integer');
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

function resetClient() {
  client = null;
}

function getClient() {
  if (client) return client;
  const cfg = appConfig.get();
  if (!cfg || !cfg.apiId || !cfg.apiHash) {
    throw new Error('App is not configured yet (missing api_id/api_hash)');
  }
  const session = new StringSession(loadSession());
  // Keep GramJS's own internal retry count low — our caller (renderer's
  // attemptConnect) already retries with its own backoff on top of this, so
  // a high value here just multiplies the wait before the UI can react.
  const options = { connectionRetries: 1, retryDelay: 1000 };
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
  const existing = loadSession();
  if (!existing) return { loggedIn: false, reason: 'no_session' };
  const c = getClient();
  try {
    // client.connect() resolves to `false` on failure instead of throwing —
    // calling getMe() afterward without checking this would hang forever
    // waiting for a response over a connection that was never established.
    const connected = await c.connect();
    if (!connected) {
      return { loggedIn: false, reason: 'connection_failed', error: new Error('Connection failed') };
    }
    const me = await c.getMe();
    return me ? { loggedIn: true } : { loggedIn: false, reason: 'connection_failed' };
  } catch (err) {
    return { loggedIn: false, reason: 'connection_failed', error: err };
  }
}

async function sendCode(phone) {
  const c = getClient();
  const cfg = appConfig.get();
  const connected = await c.connect();
  if (!connected) throw new Error('Connection failed');
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
    const buf = await c.downloadMedia(message, { thumb: 0 });
    if (!buf || !buf.length) return null;
    return `data:${sniffImageMime(buf)};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

const THUMB_CONCURRENCY = 4;

function fetchThumbnailsInBackground(c, messages, onThumbnail) {
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < messages.length) {
      const m = messages[nextIndex++];
      const type = classify(m);
      if (!type) continue;
      const thumbnail = await getThumbnailDataUri(c, m, type);
      if (thumbnail) onThumbnail(m.id, thumbnail);
    }
  }
  Promise.all(Array.from({ length: THUMB_CONCURRENCY }, worker)).catch(() => {});
}

function toMediaItem(m, type) {
  const filename = filenameFor(m, type);
  const size = m.document?.size ? Number(m.document.size) : null;
  const caption = m.message ? m.message.slice(0, 140) : '';
  return {
    id: m.id,
    type,
    filename,
    size,
    date: m.date ? m.date * 1000 : null,
    caption,
    thumbnail: null,
  };
}

const TARGET_PAGE_SIZE = 50;
const RAW_SCAN_PAGE_SIZE = 100;
const MAX_RAW_PAGES_PER_CALL = 10;

async function listMediaBatch(chatId, filterKey, offsetId, onThumbnail) {
  const c = getClient();
  const filterClass = MEDIA_FILTERS[filterKey];
  let currentOffset = offsetId || 0;
  const mediaMessages = [];
  let done = false;

  if (filterClass) {
    const raw = await c.getMessages(chatId, {
      limit: TARGET_PAGE_SIZE,
      offsetId: currentOffset,
      filter: new filterClass({}),
    });
    mediaMessages.push(...raw);
    currentOffset = raw.length ? raw[raw.length - 1].id : currentOffset;
    done = raw.length < TARGET_PAGE_SIZE;
  } else {
    // No server-side filter for "any media type" exists, so scan raw history
    // pages (which include plain text messages) until we've gathered a full
    // page of media items, instead of giving up after a single raw page.
    for (let page = 0; page < MAX_RAW_PAGES_PER_CALL; page++) {
      const raw = await c.getMessages(chatId, {
        limit: RAW_SCAN_PAGE_SIZE,
        offsetId: currentOffset,
      });
      if (!raw.length) {
        done = true;
        break;
      }
      currentOffset = raw[raw.length - 1].id;
      for (const m of raw) {
        if (classify(m)) mediaMessages.push(m);
      }
      if (raw.length < RAW_SCAN_PAGE_SIZE) {
        done = true;
        break;
      }
      if (mediaMessages.length >= TARGET_PAGE_SIZE) break;
    }
  }

  const items = mediaMessages.map((m) => toMediaItem(m, classify(m)));

  if (onThumbnail) fetchThumbnailsInBackground(c, mediaMessages, onThumbnail);

  return { items, done, nextOffsetId: currentOffset };
}

function largestPhotoSize(photo) {
  const candidates = (photo.sizes || []).filter(
    (s) => 'type' in s && !(s instanceof Api.PhotoStrippedSize) && !(s instanceof Api.PhotoPathSize)
  );
  let best = null;
  for (const s of candidates) {
    const size = s instanceof Api.PhotoSizeProgressive ? Math.max(...s.sizes) : s.size;
    if (!best || size > best.size) best = { photoSize: s, size };
  }
  return best;
}

function resumableFileLocation(message) {
  if (message.document) {
    const doc = message.document;
    return {
      fileLocation: new Api.InputDocumentFileLocation({
        id: doc.id,
        accessHash: doc.accessHash,
        fileReference: doc.fileReference,
        thumbSize: '',
      }),
      totalSize: bigInt(doc.size),
      dcId: doc.dcId,
    };
  }
  if (message.photo) {
    const photo = message.photo;
    const largest = largestPhotoSize(photo);
    if (!largest) return null;
    return {
      fileLocation: new Api.InputPhotoFileLocation({
        id: photo.id,
        accessHash: photo.accessHash,
        fileReference: photo.fileReference,
        thumbSize: largest.photoSize.type,
      }),
      totalSize: bigInt(largest.size),
      dcId: photo.dcId,
    };
  }
  return null;
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
  const partPath = `${destPath}.part`;

  const resumable = resumableFileLocation(message);
  if (resumable && fs.existsSync(destPath) && fs.statSync(destPath).size === Number(resumable.totalSize)) {
    onProgress(100);
    return destPath;
  }
  if (!resumable) {
    // Fallback for media types with no resumable file location (rare) —
    // downloads in one shot, no resume support.
    const buffer = await c.downloadMedia(message, {
      progressCallback: (received, total) => {
        if (total) onProgress(Math.round((Number(received) / Number(total)) * 100));
      },
    });
    fs.writeFileSync(destPath, buffer);
    return destPath;
  }

  const { fileLocation, totalSize, dcId } = resumable;
  let existingSize = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;
  if (existingSize > Number(totalSize)) existingSize = 0; // stale/corrupt partial, restart

  if (existingSize === Number(totalSize)) {
    fs.renameSync(partPath, destPath);
    return destPath;
  }

  const writeStream = fs.createWriteStream(partPath, { flags: 'a' });
  let received = existingSize;
  try {
    for await (const chunk of c.iterDownload({
      file: fileLocation,
      offset: bigInt(existingSize),
      fileSize: totalSize,
      dcId,
      requestSize: 512 * 1024,
    })) {
      await new Promise((resolve, reject) => {
        writeStream.write(chunk, (err) => (err ? reject(err) : resolve()));
      });
      received += chunk.length;
      onProgress(Math.round((received / Number(totalSize)) * 100));
    }
  } finally {
    await new Promise((resolve) => writeStream.end(resolve));
  }

  fs.renameSync(partPath, destPath);
  return destPath;
}

module.exports = {
  resetClient,
  restoreSession,
  sendCode,
  verifyCode,
  verifyPassword,
  logout,
  listChats,
  listMediaBatch,
  downloadOne,
};
