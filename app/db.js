const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

// Атомарная запись JSON через .tmp + rename (sync, защищает от partial-write при kill процесса).
function writeJsonAtomic(file, data, opts) {
  const tmp = file + '.tmp.' + process.pid + '.' + crypto.randomBytes(4).toString('hex');
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, (opts && opts.pretty) ? 2 : 0));
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

function loadShares() {
  try { return JSON.parse(fs.readFileSync(config.SHARES_FILE, 'utf8')); }
  catch { return {}; }
}

function saveShares(s) {
  writeJsonAtomic(config.SHARES_FILE, s);
}

function shareOptionsFromBody(body = {}) {
  const maxDownloadsRaw = parseInt(body.maxDownloads, 10);
  const expiresInRaw = parseInt(body.expiresIn, 10);
  const out = {
    downloads: 0,
    maxDownloads: Number.isFinite(maxDownloadsRaw) && maxDownloadsRaw > 0 ? maxDownloadsRaw : null,
    expiresAt: null,
    preview: !!body.preview,
  };
  if (Number.isFinite(expiresInRaw) && expiresInRaw > 0) {
    out.expiresAt = new Date(Date.now() + expiresInRaw * 60 * 60 * 1000).toISOString();
  }
  if (body.password && typeof body.password === 'string' && body.password.trim().length > 0) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(body.password.trim(), Buffer.from(salt, 'hex'), 1000, 32, 'sha256').toString('hex');
    out.passwordHash = hash;
    out.passwordSalt = salt;
  }
  return out;
}

function shareIsExpired(s) {
  if (!s) return true;
  if (s.expiresAt && Date.now() > new Date(s.expiresAt).getTime()) return true;
  if (s.maxDownloads && (s.downloads || 0) >= s.maxDownloads) return true;
  return false;
}

function loadTgUsers() {
  try { return JSON.parse(fs.readFileSync(config.TG_USERS_FILE, 'utf8')); }
  catch { return {}; }
}

function saveTgUsers(t) {
  writeJsonAtomic(config.TG_USERS_FILE, t);
}

function loadTokens() {
  try { return JSON.parse(fs.readFileSync(config.TOKENS_FILE, 'utf8')); }
  catch { return {}; }
}

function saveTokens(t) {
  writeJsonAtomic(config.TOKENS_FILE, t);
}

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(config.SETTINGS_FILE, 'utf8')); }
  catch { return {}; }
}

function saveSettings(s) {
  writeJsonAtomic(config.SETTINGS_FILE, s);
}

function getUserRetention(username) {
  const s = loadSettings();
  const val = s[username];
  if (val && typeof val === 'object') return val.retention !== undefined ? val.retention : 7;
  return (val !== undefined) ? val : 7;
}

function getUserMaxTgSize(username) {
  const s = loadSettings();
  const val = s[username];
  if (val && typeof val === 'object') return val.maxTgSize !== undefined ? val.maxTgSize : 20;
  const legacyVal = s[username + '_max_tg_size'];
  return legacyVal !== undefined ? legacyVal : 20;
}

function getUserAccentHex(username) {
  const s = loadSettings();
  const val = s[username];
  if (val && typeof val === 'object') return val.accentHex || null;
  return null;
}

function getUserQuotaGb(username) {
  const s = loadSettings();
  const val = s[username];
  if (val && typeof val === 'object') return val.quotaGb != null ? val.quotaGb : null;
  return null;
}

function getUserDiskUsedBytes(username) {
  try {
    const dir = path.join(config.DOWNLOADS_ROOT, username);
    if (!fs.existsSync(dir)) return 0;
    const { execFileSync } = require('child_process');
    const out = execFileSync('du', ['-sb', dir], { timeout: 5000, encoding: 'utf8' });
    return parseInt(out.split('\t')[0], 10) || 0;
  } catch { return 0; }
}

// ─── Password helpers (PBKDF2 / SHA-256, 100 000 итераций) ───────────────────
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(plain).trim(), Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex');
  return { passwordHash: hash, passwordSalt: salt };
}

function verifyPassword(plain, user) {
  if (!user) return false;
  // Новый формат: PBKDF2
  if (user.passwordHash && user.passwordSalt) {
    const test = crypto.pbkdf2Sync(String(plain).trim(), Buffer.from(user.passwordSalt, 'hex'), 100000, 32, 'sha256').toString('hex');
    return test === user.passwordHash;
  }
  // Старый формат (plaintext) — используем при миграции
  return user.password === plain;
}

// ─── Session secret: читаем из файла или генерируем новый ────────────────────
function getSessionSecret() {
  try {
    const s = fs.readFileSync(config.SECRET_FILE, 'utf8').trim();
    if (s && s.length >= 32) return s;
  } catch {}
  const secret = crypto.randomBytes(48).toString('hex');
  try { fs.writeFileSync(config.SECRET_FILE, secret, { mode: 0o600 }); } catch {}
  return secret;
}

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(config.USERS_FILE, 'utf8')); }
  catch {
    // Первый запуск: создаём admin с случайным паролем, выводим в лог
    const tempPass = crypto.randomBytes(8).toString('hex');
    const { passwordHash, passwordSalt } = hashPassword(tempPass);
    const def = { xf1st: { passwordHash, passwordSalt, label: 'Admin', isAdmin: true } };
    writeJsonAtomic(config.USERS_FILE, def, { pretty: true });
    console.log('\n⚠️  ПЕРВЫЙ ЗАПУСК — временный пароль для xf1st: ' + tempPass + '\n    Смени его в настройках сразу после входа!\n');
    return def;
  }
}

function saveUsers(u) {
  writeJsonAtomic(config.USERS_FILE, u, { pretty: true });
}

function isAdmin(username) {
  const u = loadUsers();
  return u[username] && u[username].isAdmin;
}

function loadUploads() {
  try { return JSON.parse(fs.readFileSync(config.UPLOADS_FILE, 'utf8')); }
  catch { return {}; }
}

function saveUploads(u) {
  try { writeJsonAtomic(config.UPLOADS_FILE, u, { pretty: true }); } catch (e) {}
}

function registerUploadedFile(username, filename) {
  if (!username || !filename) return;
  try {
    const u = loadUploads();
    if (!u[username]) u[username] = {};
    u[username][filename] = true;
    saveUploads(u);
  } catch (e) {
    console.error('Error saving uploads:', e);
  }
}

function isUploadedFile(username, filename) {
  if (!username || !filename) return false;
  try {
    const u = loadUploads();
    return !!(u[username] && u[username][filename]);
  } catch (e) {
    return false;
  }
}

function removeUploadedFile(username, filename) {
  if (!username || !filename) return;
  try {
    const u = loadUploads();
    if (u[username] && u[username][filename]) {
      delete u[username][filename];
      saveUploads(u);
    }
  } catch (e) {}
}

function loadActivity() {
  try { return JSON.parse(fs.readFileSync(config.ACTIVITY_FILE, 'utf8')); }
  catch { return []; }
}

function logActivity(username, action, details) {
  try {
    const dir = path.dirname(config.ACTIVITY_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const list = loadActivity();
    list.unshift({
      timestamp: new Date().toISOString(),
      username: username || 'system',
      action: action,
      details: details
    });
    if (list.length > 200) list.length = 200;
    writeJsonAtomic(config.ACTIVITY_FILE, list, { pretty: true });
  } catch (e) {
    console.error('Error logging activity:', e);
  }
}

module.exports = {
  writeJsonAtomic,
  loadShares,
  saveShares,
  shareOptionsFromBody,
  shareIsExpired,
  loadTgUsers,
  saveTgUsers,
  loadTokens,
  saveTokens,
  loadSettings,
  saveSettings,
  getUserRetention,
  getUserMaxTgSize,
  getUserAccentHex,
  getUserQuotaGb,
  getUserDiskUsedBytes,
  hashPassword,
  verifyPassword,
  getSessionSecret,
  loadUsers,
  saveUsers,
  isAdmin,
  loadUploads,
  saveUploads,
  registerUploadedFile,
  isUploadedFile,
  removeUploadedFile,
  loadActivity,
  logActivity,
};
