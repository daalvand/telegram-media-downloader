const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function filePath() {
  return path.join(app.getPath('userData'), 'app-config.json');
}

function migrateFromEnvFile() {
  const envPath = path.join(__dirname, '..', '..', '.env');
  if (!fs.existsSync(envPath)) return null;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  if (!env.TG_API_ID || !env.TG_API_HASH) return null;
  return set({
    apiId: env.TG_API_ID,
    apiHash: env.TG_API_HASH,
    proxyEnabled: !!env.TG_PROXY_HOST,
    proxyType: 'socks5',
    proxyHost: env.TG_PROXY_HOST,
    proxyPort: env.TG_PROXY_PORT,
  });
}

function get() {
  try {
    return JSON.parse(fs.readFileSync(filePath(), 'utf8'));
  } catch {
    return migrateFromEnvFile();
  }
}

function set({ apiId, apiHash, proxyEnabled, proxyType, proxyHost, proxyPort }) {
  const dir = path.dirname(filePath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const data = {
    apiId: Number(apiId),
    apiHash: String(apiHash),
    proxyEnabled: !!proxyEnabled,
    proxyType: proxyType === 'socks4' ? 'socks4' : 'socks5',
    proxyHost: proxyHost || '127.0.0.1',
    proxyPort: Number(proxyPort) || 10801,
  };
  fs.writeFileSync(filePath(), JSON.stringify(data, null, 2));
  return data;
}

function isConfigured() {
  const cfg = get();
  return !!(cfg && cfg.apiId && cfg.apiHash);
}

module.exports = { get, set, isConfigured };
