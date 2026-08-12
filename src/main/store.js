const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function filePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(filePath(), 'utf8'));
  } catch {
    return {};
  }
}

function get(key) {
  return readAll()[key];
}

function set(key, value) {
  const data = readAll();
  data[key] = value;
  const dir = path.dirname(filePath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(data, null, 2));
}

module.exports = { get, set };
