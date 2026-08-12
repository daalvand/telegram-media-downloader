const screens = {
  loading: document.getElementById('screen-loading'),
  setup: document.getElementById('screen-setup'),
  login: document.getElementById('screen-login'),
  chats: document.getElementById('screen-chats'),
  media: document.getElementById('screen-media'),
  downloads: document.getElementById('screen-downloads'),
};

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.add('hidden'));
  screens[name].classList.remove('hidden');
}

const ERROR_MESSAGES = {
  wrong_code: 'Wrong code, try again.',
  wrong_password: 'Wrong 2FA password, try again.',
  flood_wait: 'Too many attempts — Telegram asked us to wait before retrying.',
  proxy_unreachable: "Can't reach Telegram — check your proxy is running on 127.0.0.1:10801.",
  unknown: 'Something went wrong. Please try again.',
};

function showLoginError(code) {
  const el = document.getElementById('login-error');
  el.textContent = ERROR_MESSAGES[code] || ERROR_MESSAGES.unknown;
  el.classList.remove('hidden');
}

let settingsReturnScreen = 'login';
let editingConfigWhileLoggedIn = false;

document.getElementById('btn-open-mytelegram').addEventListener('click', () => {
  window.tg.openExternal('https://my.telegram.org/apps');
});

document.getElementById('btn-open-settings').addEventListener('click', async () => {
  const { config } = await window.tg.getAppConfig();
  if (config) {
    document.getElementById('setup-api-id').value = config.apiId;
    document.getElementById('setup-api-hash').value = config.apiHash;
    document.getElementById('setup-proxy-type').value = config.proxyType || 'socks5';
    document.getElementById('setup-proxy-host').value = config.proxyEnabled ? config.proxyHost : '';
    document.getElementById('setup-proxy-port').value = config.proxyEnabled ? config.proxyPort : '';
  }
  document.getElementById('setup-error').classList.add('hidden');
  document.getElementById('btn-cancel-setup').classList.remove('hidden');
  settingsReturnScreen = 'chats';
  editingConfigWhileLoggedIn = true;
  showScreen('setup');
});

document.getElementById('btn-save-setup').addEventListener('click', async () => {
  const apiId = document.getElementById('setup-api-id').value.trim();
  const apiHash = document.getElementById('setup-api-hash').value.trim();
  const proxyType = document.getElementById('setup-proxy-type').value;
  const proxyHost = document.getElementById('setup-proxy-host').value.trim();
  const proxyPort = document.getElementById('setup-proxy-port').value.trim();
  const proxyEnabled = !!proxyHost;
  const errEl = document.getElementById('setup-error');
  errEl.classList.add('hidden');

  if (!apiId || !apiHash) {
    errEl.textContent = 'api_id and api_hash are required.';
    errEl.classList.remove('hidden');
    return;
  }
  if (proxyHost && !proxyPort) {
    errEl.textContent = 'Enter a proxy port, or clear the proxy host to skip using a proxy.';
    errEl.classList.remove('hidden');
    return;
  }
  const res = await window.tg.setAppConfig({
    apiId,
    apiHash,
    proxyEnabled,
    proxyType,
    proxyHost,
    proxyPort,
  });
  if (!res.ok) {
    errEl.textContent = res.error || 'Failed to save settings.';
    errEl.classList.remove('hidden');
    return;
  }
  document.getElementById('btn-cancel-setup').classList.add('hidden');
  if (editingConfigWhileLoggedIn) {
    editingConfigWhileLoggedIn = false;
    await window.tg.logout();
    showScreen('login');
  } else {
    showScreen(settingsReturnScreen);
  }
});

document.getElementById('btn-cancel-setup').addEventListener('click', () => {
  document.getElementById('btn-cancel-setup').classList.add('hidden');
  editingConfigWhileLoggedIn = false;
  showScreen(settingsReturnScreen);
});

let currentPhone = '';

document.getElementById('btn-send-code').addEventListener('click', async () => {
  currentPhone = document.getElementById('phone').value.trim();
  if (!currentPhone) return;
  const res = await window.tg.sendCode(currentPhone);
  if (res.ok) {
    document.getElementById('login-step-phone').classList.add('hidden');
    document.getElementById('login-step-code').classList.remove('hidden');
  } else {
    showLoginError(res.error);
  }
});

document.getElementById('btn-verify-code').addEventListener('click', async () => {
  const code = document.getElementById('code').value.trim();
  const res = await window.tg.verify(code);
  if (res.ok && res.needsPassword) {
    document.getElementById('login-step-code').classList.add('hidden');
    document.getElementById('login-step-password').classList.remove('hidden');
  } else if (res.ok) {
    enterApp();
  } else {
    showLoginError(res.error);
  }
});

document.getElementById('btn-verify-password').addEventListener('click', async () => {
  const password = document.getElementById('password').value;
  const res = await window.tg.verifyPassword(password);
  if (res.ok) {
    enterApp();
  } else {
    showLoginError(res.error);
  }
});

document.getElementById('btn-logout').addEventListener('click', async () => {
  await window.tg.logout();
  location.reload();
});

async function enterApp() {
  showScreen('chats');
  await loadChats();
}

async function loadChats() {
  const list = document.getElementById('chat-list');
  list.innerHTML = '<li>Loading...</li>';
  const res = await window.tg.listChats();
  if (!res.ok) {
    list.innerHTML = `<li>${ERROR_MESSAGES[res.error] || ERROR_MESSAGES.unknown}</li>`;
    return;
  }
  renderChatList(res.chats);
}

let allChats = [];

function renderChatList(chats) {
  allChats = chats;
  const list = document.getElementById('chat-list');
  list.innerHTML = '';
  chats.forEach((chat) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="name">${chat.name}</span><span class="meta">${chat.type}</span>`;
    li.addEventListener('click', () => openChat(chat));
    list.appendChild(li);
  });
}

document.getElementById('chat-search').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  renderChatList(allChats.filter((c) => c.name.toLowerCase().includes(q)));
});

document.getElementById('btn-back-to-chats').addEventListener('click', () => {
  showScreen('chats');
});

// ---- Media browser ----

let currentChat = null;
let currentFilter = '';
let offsetId = 0;
let loadingMedia = false;
let mediaDone = false;
let loadedItems = new Map(); // id -> item
let selected = new Set();

async function openChat(chat) {
  currentChat = chat;
  currentFilter = '';
  offsetId = 0;
  mediaDone = false;
  loadedItems = new Map();
  selected = new Set();
  document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
  document.querySelector('.chip[data-filter=""]').classList.add('active');
  document.getElementById('media-chat-name').textContent = chat.name;
  document.getElementById('media-list').innerHTML = '';
  updateSelectionSummary();
  showScreen('media');
  await loadMoreMedia();
}

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', async () => {
    document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    currentFilter = chip.dataset.filter;
    offsetId = 0;
    mediaDone = false;
    loadedItems = new Map();
    selected = new Set();
    document.getElementById('media-list').innerHTML = '';
    updateSelectionSummary();
    await loadMoreMedia();
  });
});

async function loadMoreMedia() {
  if (loadingMedia || mediaDone) return;
  loadingMedia = true;
  document.getElementById('media-status').textContent = 'Loading...';
  const res = await window.tg.listMedia(currentChat.id, currentFilter, offsetId);
  loadingMedia = false;
  if (!res.ok) {
    document.getElementById('media-status').textContent =
      ERROR_MESSAGES[res.error] || ERROR_MESSAGES.unknown;
    return;
  }
  mediaDone = res.done;
  offsetId = res.nextOffsetId || offsetId;
  appendMediaItems(res.items);
  document.getElementById('media-status').textContent = mediaDone ? 'End of list.' : '';
}

function formatSize(bytes) {
  if (!bytes) return '';
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function appendMediaItems(items) {
  const list = document.getElementById('media-list');
  items.forEach((item) => {
    loadedItems.set(item.id, item);
    const li = document.createElement('li');
    li.dataset.id = item.id;
    const thumbHtml = item.thumbnail
      ? `<img class="thumb" src="${item.thumbnail}" alt="" />`
      : `<span class="thumb thumb-placeholder">${item.type[0].toUpperCase()}</span>`;
    const captionHtml = item.caption
      ? `<span class="caption">${escapeHtml(item.caption)}</span>`
      : '';
    li.innerHTML = `
      <input type="checkbox" class="item-select" />
      ${thumbHtml}
      <span class="info">
        <span class="name">${escapeHtml(item.filename)}</span>
        <span class="meta">${item.type} · ${formatSize(item.size)}</span>
        ${captionHtml}
      </span>
    `;
    li.querySelector('.item-select').addEventListener('change', (e) => {
      if (e.target.checked) selected.add(item.id);
      else selected.delete(item.id);
      updateSelectionSummary();
    });
    list.appendChild(li);
  });
}

document.getElementById('screen-media').addEventListener('scroll', (e) => {
  const el = e.target;
  if (el.scrollTop + el.clientHeight > el.scrollHeight - 200) {
    loadMoreMedia();
  }
});

document.getElementById('select-all').addEventListener('change', (e) => {
  document.querySelectorAll('.item-select').forEach((cb) => {
    cb.checked = e.target.checked;
    const id = Number(cb.closest('li').dataset.id);
    if (e.target.checked) selected.add(id);
    else selected.delete(id);
  });
  updateSelectionSummary();
});

function updateSelectionSummary() {
  let totalSize = 0;
  selected.forEach((id) => {
    const item = loadedItems.get(id);
    if (item?.size) totalSize += item.size;
  });
  document.getElementById('selection-summary').textContent =
    `${selected.size} selected (${formatSize(totalSize)})`;
}

// ---- Downloads ----

document.getElementById('btn-download-selected').addEventListener('click', async () => {
  if (!selected.size) return;
  let settings = await window.tg.getSettings();
  let folder = settings.downloadFolder;
  if (!folder) {
    const res = await window.tg.chooseFolder();
    if (!res.ok) return;
    folder = res.folder;
  }
  startDownloads(Array.from(selected), folder);
});

function startDownloads(messageIds, folder) {
  showScreen('downloads');
  const list = document.getElementById('download-list');
  list.innerHTML = '';
  messageIds.forEach((id) => {
    const item = loadedItems.get(id);
    const li = document.createElement('li');
    li.dataset.id = id;
    li.innerHTML = `
      <span class="name">${item?.filename || id}</span>
      <progress value="0" max="100"></progress>
      <span class="meta status-text">Pending</span>
    `;
    list.appendChild(li);
  });
  window.tg.download(currentChat.id, messageIds, folder);
}

window.tg.onDownloadProgress(({ messageId, percent }) => {
  const li = document.querySelector(`#download-list li[data-id="${messageId}"]`);
  if (!li) return;
  li.querySelector('progress').value = percent;
  li.querySelector('.status-text').textContent = `${percent}%`;
});

window.tg.onDownloadDone(({ messageId, ok, error }) => {
  const li = document.querySelector(`#download-list li[data-id="${messageId}"]`);
  if (!li) return;
  if (ok) {
    li.querySelector('progress').value = 100;
    li.querySelector('.status-text').textContent = 'Done';
  } else {
    li.querySelector('.status-text').textContent = `Failed: ${error}`;
    const retry = document.createElement('button');
    retry.textContent = 'Retry';
    retry.addEventListener('click', async () => {
      const folder = (await window.tg.getSettings()).downloadFolder;
      window.tg.download(currentChat.id, [messageId], folder);
    });
    li.appendChild(retry);
  }
});

document.getElementById('btn-close-downloads').addEventListener('click', () => {
  showScreen('media');
});

// ---- Startup ----

(async () => {
  const { configured, config } = await window.tg.getAppConfig();
  if (!configured) {
    showScreen('setup');
    return;
  }
  if (config) {
    document.getElementById('setup-api-id').value = config.apiId;
    document.getElementById('setup-api-hash').value = config.apiHash;
    document.getElementById('setup-proxy-host').value = config.proxyHost;
    document.getElementById('setup-proxy-port').value = config.proxyPort;
  }
  const res = await window.tg.restoreSession();
  if (res.loggedIn) {
    await enterApp();
  } else {
    showScreen('login');
  }
})();
