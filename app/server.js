const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const FormData = require('form-data');
const QRCode = require('qrcode');
const { exec, execFile, spawn } = require('child_process');
const multer = require('multer');
const archiver = require('archiver');
const VT_API_KEY = '93c0c934a298f0f35b0f95be051de5b4e4ea7340fa3c7bb8fd5c1f572a13c2b8';
const SHARES_FILE = '/opt/vps-downloader/shares.json';
const MEDIA_JOBS_FILE = '/opt/vps-downloader/media-jobs.json';
const mediaProcesses = new Map();
function loadShares() {
  try { return JSON.parse(fs.readFileSync(SHARES_FILE, 'utf8')); }
  catch { return {}; }
}
function saveShares(s) {
  writeJsonAtomic(SHARES_FILE, s);
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
const TOKENS_FILE = '/opt/vps-downloader/tokens.json';
const SETTINGS_FILE = '/opt/vps-downloader/settings.json';
const TG_TOKEN = '8981938565:AAGrVbZwhuuw_AEFauvwr4tWVVhOgUCHNQ4';
const TG_BOT_NAME = 'SiplyiFolderUpload_bot';
const TG_USERS_FILE = '/opt/vps-downloader/tg-users.json';
function loadTgUsers() {
  try { return JSON.parse(fs.readFileSync(TG_USERS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveTgUsers(t) { writeJsonAtomic(TG_USERS_FILE, t); }
async function tgPost(method, data, options = {}) {
  const isFormData = data && typeof data.getHeaders === 'function';
  const headers = isFormData ? data.getHeaders() : {};
  const config = {
    headers: { ...headers, ...options.headers },
    timeout: options.timeout || 35000,
  };
  try {
    const r = await axios.post(`http://localhost:8081/bot${TG_TOKEN}/${method}`, data, config);
    return r.data;
  } catch (e) {
    if (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND') {
      console.warn(`Local Telegram Bot API server not reachable for ${method}, falling back to api.telegram.org. Error: ${e.message}`);
      const r = await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, data, config);
      return r.data;
    }
    throw e;
  }
}
async function tgApi(method, params = {}, options = {}) {
  return tgPost(method, params, options);
}
async function tgSend(chatId, text) {
  return tgApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
}
function loadTokens() {
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveTokens(t) { writeJsonAtomic(TOKENS_FILE, t); }
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveSettings(s) { writeJsonAtomic(SETTINGS_FILE, s); }
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
const VT_API = 'https://www.virustotal.com/api/v3';
const app = express();
const PORT = 3000;
const SITE_VERSION = '2.12.0';
const ARIA2_URL = 'http://localhost:6800/jsonrpc';
const ARIA2_TOKEN = 'mySecretToken123';
const DOWNLOADS_ROOT = '/var/downloads';
const USERS_FILE = '/opt/vps-downloader/users.json';
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch {
    const def = { xf1st: { password: '78457845Xf!', label: 'Admin', isAdmin: true } };
    writeJsonAtomic(USERS_FILE, def, { pretty: true });
    return def;
  }
}
function saveUsers(u) { writeJsonAtomic(USERS_FILE, u, { pretty: true }); }
function isAdmin(username) { const u = loadUsers(); return u[username] && u[username].isAdmin; }
const UPLOADS_FILE = '/opt/vps-downloader/uploads.json';
function loadUploads() {
  try { return JSON.parse(fs.readFileSync(UPLOADS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveUploads(u) {
  try { writeJsonAtomic(UPLOADS_FILE, u, { pretty: true }); } catch (e) {}
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
const ACTIVITY_FILE = '/opt/vps-downloader/activity.json';
function loadActivity() {
  try { return JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf8')); }
  catch { return []; }
}
function logActivity(username, action, details) {
  try {
    const dir = path.dirname(ACTIVITY_FILE);
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
    writeJsonAtomic(ACTIVITY_FILE, list, { pretty: true });
  } catch (e) {
    console.error('Error logging activity:', e);
  }
}
function htmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// SSRF-защита для aria2.addUri: запрет file://, приватных IP, localhost, link-local.
function isUriSafe(uri) {
  if (typeof uri !== 'string') return false;
  uri = uri.trim();
  if (!uri) return false;
  if (/^magnet:/i.test(uri)) return true;
  let u;
  try { u = new URL(uri); } catch { return false; }
  const proto = u.protocol.toLowerCase();
  if (!['http:', 'https:', 'ftp:', 'ftps:'].includes(proto)) return false;
  const host = (u.hostname || '').toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') return false;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b, c, d] = ipv4.slice(1).map(Number);
    if (a > 255 || b > 255 || c > 255 || d > 255) return false;
    if (a === 127 || a === 10 || a === 0) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false; // AWS metadata / link-local
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a >= 224) return false;
  }
  if (host.startsWith('[')) {
    const v6 = host.slice(1, -1);
    if (v6 === '::1' || v6 === '0:0:0:0:0:0:0:1' || v6 === '::' ) return false;
    if (/^f[cd][0-9a-f]{2}:/i.test(v6)) return false; // ULA
    if (/^fe[89ab][0-9a-f]:/i.test(v6)) return false; // link-local
  }
  return true;
}

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

// Brute-force tracker для /login (in-memory).
const _loginFails = new Map();
function loginGate(ip) {
  const e = _loginFails.get(ip);
  if (!e) return { ok: true };
  if (e.lockUntil && Date.now() < e.lockUntil) {
    return { ok: false, retryAfter: Math.ceil((e.lockUntil - Date.now()) / 1000) };
  }
  return { ok: true };
}
function loginFail(ip) {
  const e = _loginFails.get(ip) || { fails: 0, lockUntil: 0 };
  e.fails++;
  if (e.fails >= 5) {
    // экспоненциально: 5→30с, 6→60с, 7→120с… потолок 30 мин
    e.lockUntil = Date.now() + Math.min(30000 * Math.pow(2, e.fails - 5), 1800000);
  }
  _loginFails.set(ip, e);
}
function loginOk(ip) { _loginFails.delete(ip); }
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of _loginFails) {
    if (e.lockUntil && e.lockUntil < now - 3600000) _loginFails.delete(ip);
  }
}, 600000).unref?.();

// Запретённые для загрузки расширения (XSS через preview, скрипты).
const FORBIDDEN_UPLOAD_EXT = new Set(['.html', '.htm', '.svg', '.xhtml', '.xml', '.js', '.mjs']);
function multerFileFilter(req, file, cb) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (FORBIDDEN_UPLOAD_EXT.has(ext)) {
    return cb(new Error('Расширение ' + ext + ' запрещено'));
  }
  cb(null, true);
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('/opt/vps-downloader/public', { maxAge: '7d' }));
app.use(session({
  store: new FileStore({ path: '/opt/vps-downloader/sessions', ttl: 30 * 24 * 60 * 60 }),
  secret: 'vps-dl-secret-key-2024',
  resave: true,
  saveUninitialized: false,
  rolling: true,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' }, // 30 дней, обновляется при каждом Р В·Р В°Р С—росе
}));
function auth(req, res, next) {
  if (req.session.user) return next();
  res.redirect('/login');
}
function userDir(username) {
  const dir = path.join(DOWNLOADS_ROOT, username);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
async function aria2(method, params = []) {
  const res = await axios.post(ARIA2_URL, {
    jsonrpc: '2.0', id: '1', method,
    params: [`token:${ARIA2_TOKEN}`, ...params],
  });
  return res.data.result;
}
function loadMediaJobs() {
  try { return JSON.parse(fs.readFileSync(MEDIA_JOBS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveMediaJobs(jobs) {
  writeJsonAtomic(MEDIA_JOBS_FILE, jobs, { pretty: true });
}
function mediaJobPublic(job) {
  const rawError = job.error || '';
  const isWarningOnly = /^WARNING:/i.test(rawError) && ['active', 'processing', 'complete'].includes(job.status);
  return {
    id: job.id,
    url: job.url,
    mode: job.mode,
    status: job.status,
    progress: job.progress || 0,
    speed: job.speed || '',
    eta: job.eta || '',
    name: job.name || 'Media download',
    file: job.file || '',
    folder: job.folder || '',
    error: isWarningOnly ? '' : rawError,
    warning: job.warning || (isWarningOnly ? rawError : ''),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}
async function syncAriaDownloadJobs(username) {
  const dir = userDir(username);
  const jobs = loadMediaJobs();
  let changed = false;
  let all = [];
  try {
    const [active, waiting, stopped] = await Promise.all([
      aria2('aria2.tellActive'),
      aria2('aria2.tellWaiting', [0, 1000]),
      aria2('aria2.tellStopped', [0, 1000]),
    ]);
    all = [...active, ...waiting, ...stopped].filter(d => d.dir && d.dir.startsWith(dir));
  } catch {
    all = [];
  }
  const seen = new Set();
  all.forEach(d => {
    seen.add(d.gid);
    const j = jobs[d.gid];
    if (!j || j.user !== username) return;
    const filePath = d.files?.[0]?.path || '';
    const fileName = filePath ? path.basename(filePath) : '';
    if (fileName && fileName !== '...') { j.file = fileName; j.name = fileName; }
    const progress = d.totalLength > 0 ? Math.round(d.completedLength / d.totalLength * 100) : (d.status === 'complete' ? 100 : (j.progress || 0));
    if (d.status === 'complete') { j.status = 'complete'; j.progress = 100; }
    else if (d.status === 'error') { j.status = 'error'; j.error = d.errorMessage || j.error || 'Download error'; j.progress = progress; }
    else if (d.status === 'active' || d.status === 'waiting' || d.status === 'paused') { j.status = d.status; j.progress = progress; j.speed = fmtBytes(parseInt(d.downloadSpeed || 0)) + '/s'; }
    j.updatedAt = new Date().toISOString();
    jobs[d.gid] = j;
    changed = true;
  });
  Object.values(jobs).forEach(j => {
    if (!j || j.user !== username || seen.has(j.id) || ['complete', 'error', 'cancelled'].includes(j.status)) return;
    const folder = fmResolve(username, j.folder || '');
    const expected = j.file || j.name;
    if (folder && expected && fs.existsSync(path.join(folder, path.basename(expected)))) {
      j.file = path.basename(expected);
      j.name = path.basename(expected);
      j.status = 'complete';
      j.progress = 100;
      j.updatedAt = new Date().toISOString();
      jobs[j.id] = j;
      changed = true;
    }
  });
  if (changed) saveMediaJobs(jobs);
  return { jobs, downloads: all };
}
function ytDlpAvailable(cb) {
  execFile('yt-dlp', ['--version'], { timeout: 5000 }, (err, stdout) => {
    cb(!err, (stdout || '').trim());
  });
}
function parseYtDlpLine(job, line) {
  const clean = String(line || '').trim();
  if (!clean) return false;
  let changed = false;
  if ((clean.startsWith('/') || /^[A-Za-z]:[\\/]/.test(clean)) && fs.existsSync(clean)) {
    job.file = path.basename(clean);
    job.name = job.file;
    changed = true;
  }
  const dest = clean.match(/Destination:\s+(.+)$/i) || clean.match(/Merging formats into\s+"(.+)"$/i);
  if (dest && dest[1]) {
    job.file = path.basename(dest[1].replace(/^"|"$/g, ''));
    job.name = job.file;
    changed = true;
  }
  const pct = clean.match(/\[download\]\s+([0-9.]+)%/);
  if (pct) {
    job.progress = Math.max(0, Math.min(100, parseFloat(pct[1])));
    changed = true;
  }
  const speed = clean.match(/\bat\s+([^\s]+\/s)/);
  if (speed) {
    job.speed = speed[1];
    changed = true;
  }
  const eta = clean.match(/\bETA\s+([^\s]+)/);
  if (eta) {
    job.eta = eta[1];
    changed = true;
  }
  if (clean.includes('[ExtractAudio]') || clean.includes('[Merger]')) {
    job.status = 'processing';
    changed = true;
  }
  return changed;
}
function newestMediaFile(dir, startedAtMs) {
  try {
    return fs.readdirSync(dir)
      .map(name => {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        return { name, full, stat };
      })
      .filter(x => x.stat.isFile() && x.stat.mtimeMs >= startedAtMs - 2000)
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0] || null;
  } catch {
    return null;
  }
}
function mediaExtOk(mode, file) {
  const ext = path.extname(file || '').toLowerCase();
  if (mode === 'audio') return ['.mp3', '.m4a', '.opus', '.ogg', '.wav', '.flac', '.aac'].includes(ext);
  return ['.mp4', '.webm', '.mkv', '.mov', '.m4v'].includes(ext);
}
function stripKnownMediaExt(name) {
  const clean = (name || '').trim().replace(/[/\\:*?"<>|]/g, '_');
  const ext = path.extname(clean).toLowerCase();
  if (['.mp4', '.webm', '.mkv', '.mov', '.m4v', '.mp3', '.m4a', '.opus', '.ogg', '.wav', '.flac', '.aac'].includes(ext)) {
    return clean.slice(0, -ext.length);
  }
  return clean;
}
function ensureMediaExtension(mode, fullPath) {
  if (!fullPath || !fs.existsSync(fullPath) || path.extname(fullPath)) return fullPath;
  const ext = mode === 'audio' ? '.mp3' : '.mp4';
  const next = fullPath + ext;
  try {
    fs.renameSync(fullPath, next);
    return next;
  } catch {
    return fullPath;
  }
}
function validateMediaFile(mode, fullPath, cb) {
  fs.stat(fullPath, (statErr, stat) => {
    if (statErr) return cb(new Error('Downloaded file was not created'));
    if (!stat.isFile() || stat.size < 64 * 1024) return cb(new Error('Downloaded file is too small or empty'));
    if (!mediaExtOk(mode, fullPath)) return cb(new Error('Downloaded file has no valid media extension: ' + path.basename(fullPath)));
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', fullPath], { timeout: 15000 }, (err, stdout) => {
      if (err) return cb(new Error('Downloaded file is not a valid media file'));
      const streams = String(stdout || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
      if (mode === 'audio' && !streams.includes('audio')) return cb(new Error('Downloaded file has no audio stream'));
      if (mode !== 'audio' && !streams.includes('video')) return cb(new Error('Downloaded file has no video stream'));
      cb(null);
    });
  });
}
function startMediaJob({ username, url, dir, relPath, mode, filename }) {
  const jobs = loadMediaJobs();
  const id = crypto.randomUUID();
  const safeBase = stripKnownMediaExt(filename);
  const output = safeBase ? (safeBase + '.%(ext)s') : '%(title).180B [%(id)s].%(ext)s';
  const startedAtMs = Date.now();
  const args = [
    '--newline',
    '--no-part',
    '--no-playlist',
    '--windows-filenames',
    '--restrict-filenames',
    '--no-mtime',
    '--print', 'after_move:filepath',
    '-o', output,
  ];
  if (mode === 'audio') args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  else if (mode === 'video') args.push('-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b', '--merge-output-format', 'mp4');
  else args.push('-f', 'b/bv*+ba/b', '--merge-output-format', 'mp4');
  args.push(url);
  const job = {
    id,
    user: username,
    url,
    mode,
    status: 'starting',
    progress: 0,
    speed: '',
    eta: '',
    name: safeBase || 'Media download',
    file: '',
    folder: relPath || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAtMs,
    error: '',
  };
  jobs[id] = job;
  saveMediaJobs(jobs);
  const child = spawn('yt-dlp', args, { cwd: dir });
  mediaProcesses.set(id, child);
  child.stdout.on('data', chunk => {
    const current = loadMediaJobs();
    const j = current[id];
    if (!j) return;
    j.status = j.status === 'starting' ? 'active' : j.status;
    String(chunk).split(/\r?\n/).forEach(line => parseYtDlpLine(j, line));
    j.updatedAt = new Date().toISOString();
    current[id] = j;
    saveMediaJobs(current);
  });
  child.stderr.on('data', chunk => {
    const current = loadMediaJobs();
    const j = current[id];
    if (!j) return;
    const lines = String(chunk).trim().split(/\r?\n/).filter(Boolean);
    const realErrors = lines.filter(line => /^ERROR:/i.test(line));
    if (realErrors.length) j.error = realErrors.slice(-2).join(' ');
    else if (lines.length) j.warning = lines.slice(-2).join(' ');
    j.updatedAt = new Date().toISOString();
    current[id] = j;
    saveMediaJobs(current);
  });
  child.on('error', err => {
    const current = loadMediaJobs();
    const j = current[id];
    if (j) {
      j.status = 'error';
      j.error = err.message;
      j.updatedAt = new Date().toISOString();
      current[id] = j;
      saveMediaJobs(current);
    }
    mediaProcesses.delete(id);
  });
  child.on('close', code => {
    const current = loadMediaJobs();
    const j = current[id];
    if (j) {
      if (j.status !== 'cancelled') {
        if (code === 0) {
          let full = j.file ? path.join(dir, j.file) : '';
          if (!full || !fs.existsSync(full)) {
            const newest = newestMediaFile(dir, j.startedAtMs || Date.now());
            if (newest) {
              full = newest.full;
              j.file = newest.name;
              j.name = newest.name;
            }
          }
          full = ensureMediaExtension(j.mode, full);
          if (full && fs.existsSync(full)) {
            j.file = path.basename(full);
            j.name = j.file;
          }
          validateMediaFile(j.mode, full, validationErr => {
            const latest = loadMediaJobs();
            const doneJob = latest[id];
            if (!doneJob) return;
            if (validationErr) {
              doneJob.status = 'error';
              doneJob.error = validationErr.message;
            } else {
              doneJob.status = 'complete';
              doneJob.progress = 100;
              doneJob.error = '';
              doneJob.file = path.basename(full);
              doneJob.name = doneJob.file;
            }
            doneJob.updatedAt = new Date().toISOString();
            latest[id] = doneJob;
            saveMediaJobs(latest);
          });
        } else if (!j.error) {
          j.status = 'error';
          j.error = 'yt-dlp exited with code ' + code;
        }
      }
      j.updatedAt = new Date().toISOString();
      current[id] = j;
      saveMediaJobs(current);
    }
    mediaProcesses.delete(id);
  });
  return job;
}
// ─── Routes ─────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.send(loginPage());
});
app.post('/login', (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
  const gate = loginGate(ip);
  if (!gate.ok) {
    res.set('Retry-After', String(gate.retryAfter));
    return res.status(429).send(loginPage('Слишком много попыток. Попробуйте через ' + gate.retryAfter + ' с.'));
  }
  const { username, password } = req.body;
  const users = loadUsers();
  const user = users[username];
  if (user && user.password === password) {
    loginOk(ip);
    req.session.user = username;
    req.session.save(() => res.redirect('/'));
    return;
  }
  loginFail(ip);
  res.send(loginPage('Неверный логин или пароль'));
});
app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});
app.get('/', auth, (req, res) => res.redirect('/cloud'));
function fmtBytes(b) {
  const units = ['B','KB','MB','GB','TB'];
  let i = 0, v = b;
  while (v >= 1024 && i < 4) { v /= 1024; i++; }
  return v.toFixed(1) + ' ' + units[i];
}
function filenameWithUrlExtension(url, filename) {
  const clean = (filename || '').trim().replace(/[/\\:*?"<>|]/g, '_');
  if (!clean) return '';
  if (path.extname(clean)) return clean;
  try {
    const parsed = new URL(url);
    const ext = path.extname(decodeURIComponent(parsed.pathname || '')).replace(/[/\\:*?"<>|]/g, '');
    return ext ? clean + ext : clean;
  } catch {
    const ext = path.extname((url || '').split(/[?#]/)[0]).replace(/[/\\:*?"<>|]/g, '');
    return ext ? clean + ext : clean;
  }
}
app.get('/api/disk', auth, (req, res) => {
  const root = fs.existsSync(DOWNLOADS_ROOT) ? DOWNLOADS_ROOT : '.';
  
  // 1. Try native fs.statfsSync if available
  if (typeof fs.statfsSync === 'function') {
    try {
      const sf = fs.statfsSync(root);
      const total = sf.blocks * sf.bsize;
      const avail = sf.bfree * sf.bsize;
      const used  = total - avail;
      const percent = total ? Math.min(100, Math.round(used / total * 100)) : 0;
      return res.json({ total: fmtBytes(total), used: fmtBytes(used), avail: fmtBytes(avail), percent });
    } catch (err) {
      console.error('fs.statfsSync error:', err.message);
    }
  }
  // 2. Fallback for older Node.js versions on Unix-like systems (Linux/macOS)
  if (process.platform !== 'win32') {
    try {
      const { execSync } = require('child_process');
      const out = execSync(`df -Pk "${root}"`, { timeout: 2000, encoding: 'utf8' });
      const lines = out.trim().split('\n');
      if (lines.length >= 2) {
        const parts = lines[1].replace(/\s+/g, ' ').split(' ');
        if (parts.length >= 4) {
          const totalKb = parseInt(parts[1], 10);
          const usedKb = parseInt(parts[2], 10);
          const availKb = parseInt(parts[3], 10);
          if (!isNaN(totalKb) && !isNaN(usedKb) && !isNaN(availKb)) {
            const total = totalKb * 1024;
            const used = usedKb * 1024;
            const avail = availKb * 1024;
            const percent = total ? Math.min(100, Math.round(used / total * 100)) : 0;
            return res.json({ total: fmtBytes(total), used: fmtBytes(used), avail: fmtBytes(avail), percent });
          }
        }
      }
    } catch (err) {
      console.error('df fallback error:', err.message);
    }
  }
  // 3. Ultimate safe fallback
  res.json({ total: '—', used: '—', avail: '—', percent: 0 });
});
app.get('/api/files', auth, (req, res) => {
  const dir = userDir(req.session.user);
  try {
    const files = fs.readdirSync(dir)
      .map(name => {
        const stat = fs.statSync(path.join(dir, name));
        return { name, size: stat.size, mtime: stat.mtime };
      })
      .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    res.json(files);
  } catch { res.json([]); }
});
app.get('/api/downloads', auth, async (req, res) => {
  try {
    const synced = await syncAriaDownloadJobs(req.session.user);
    const mine = synced.downloads
      .map(d => ({
        gid: d.gid,
        status: d.status,
        name: d.files?.[0]?.path ? path.basename(d.files[0].path) : (d.bittorrent?.info?.name || '...'),
        size: parseInt(d.totalLength || 0),
        downloaded: parseInt(d.completedLength || 0),
        speed: parseInt(d.downloadSpeed || 0),
        uploadSpeed: parseInt(d.uploadSpeed || 0),
        connections: parseInt(d.connections || 0),
        numSeeders: parseInt(d.numSeeders || 0),
        errorCode: d.errorCode || '',
        errorMessage: d.errorMessage || '',
        dir: d.dir || '',
        progress: d.totalLength > 0 ? Math.round(d.completedLength / d.totalLength * 100) : 0,
      }));
    res.json(mine);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/add', auth, async (req, res) => {
  const dlUrl = (req.body.url || '').trim();
  const outName = filenameWithUrlExtension(dlUrl, req.body.filename || '');
  if (!dlUrl) return res.status(400).json({ error: 'URL пустой' });
  if (!isUriSafe(dlUrl)) return res.status(400).json({ error: 'URL заблокирован (приватный/локальный адрес или неподдерживаемая схема)' });
  const dir = userDir(req.session.user);
  try {
    const opts = { dir };
    if (outName) opts.out = outName;
    const gid = await aria2('aria2.addUri', [[dlUrl], opts]);
    res.json({ gid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/downloads/:gid', auth, async (req, res) => {
  try {
    await aria2('aria2.remove', [req.params.gid]).catch(() =>
      aria2('aria2.removeDownloadResult', [req.params.gid])
    );
    const jobs = loadMediaJobs();
    if (jobs[req.params.gid] && jobs[req.params.gid].user === req.session.user) {
      jobs[req.params.gid].status = 'cancelled';
      jobs[req.params.gid].updatedAt = new Date().toISOString();
      saveMediaJobs(jobs);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/downloads/:gid/pause', auth, async (req, res) => {
  try {
    await aria2('aria2.pause', [req.params.gid]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/downloads/:gid/resume', auth, async (req, res) => {
  try {
    await aria2('aria2.unpause', [req.params.gid]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ─── VirusTotal ──────────────────────────────────────────────────
function sha256file(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', d => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
app.get('/api/vt/:file', auth, async (req, res) => {
  const dir = userDir(req.session.user);
  const filePath = path.join(dir, path.basename(req.params.file));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Файл не найден' });
  try {
    const hash = await sha256file(filePath);
    // Lookup by hash first
    try {
      const lookup = await axios.get(`${VT_API}/files/${hash}`, {
        headers: { 'x-apikey': VT_API_KEY }
      });
      const stats = lookup.data.data.attributes.last_analysis_stats;
      const total = Object.values(stats).reduce((a, b) => a + b, 0);
      return res.json({ hash, stats, total, cached: true });
    } catch (e) {
      if (e.response?.status !== 404) throw e;
    }
    // Not in VT — upload file (only if <= 32MB)
    const size = fs.statSync(filePath).size;
    if (size > 32 * 1024 * 1024) {
      return res.json({ hash, pending: true, message: 'Файл > 32 МБ, проверка по хэшу: не найден в базе VT' });
    }
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath), path.basename(filePath));
    const upload = await axios.post(`${VT_API}/files`, form, {
      headers: { 'x-apikey': VT_API_KEY, ...form.getHeaders() }
    });
    const analysisId = upload.data.data.id;
    // Poll for result (max 30s)
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const result = await axios.get(`${VT_API}/analyses/${analysisId}`, {
        headers: { 'x-apikey': VT_API_KEY }
      });
      const attrs = result.data.data.attributes;
      if (attrs.status === 'completed') {
        const stats = attrs.stats;
        const total = Object.values(stats).reduce((a, b) => a + b, 0);
        return res.json({ hash, stats, total, cached: false });
      }
    }
    res.json({ hash, pending: true, message: 'Анализ запущен, попробуйте через минуту' });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.error?.message || e.message });
  }
});
app.get('/download/:file', auth, (req, res) => {
  const dir = userDir(req.session.user);
  const file = path.join(dir, path.basename(req.params.file));
  if (!fs.existsSync(file)) return res.status(404).send('Not found');
  res.download(file);
});
function authToken(req, res, next) {
  const h = req.headers['authorization'] || '';
  const token = h.replace(/^Bearer\s+/, '').trim();
  if (!token) return res.status(401).json({ error: 'No token' });
  const tokens = loadTokens();
  const username = tokens[token];
  if (!username) return res.status(401).json({ error: 'Invalid token' });
  req.tokenUser = username;
  next();
}
// ─── Public share links ──────────────────────────────────────────
app.post('/api/share', auth, (req, res) => {
  const filename = path.basename(req.body.file || '');
  if (!filename) return res.status(400).json({ error: 'No file' });
  const filePath = path.join(userDir(req.session.user), filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Файл не найден' });
  const token = crypto.randomUUID();
  const shares = loadShares();
  shares[token] = Object.assign({ file: filename, user: req.session.user, created: new Date().toISOString() }, shareOptionsFromBody(req.body));
  saveShares(shares);
  res.json({ token });
});
app.get('/api/me', auth, (req, res) => {
  const users = loadUsers();
  const me = users[req.session.user] || {};
  res.json({
    username: req.session.user,
    label: me.label || req.session.user,
    isAdmin: !!me.isAdmin,
  });
});
app.patch('/api/me', auth, (req, res) => {
  const users = loadUsers();
  const me = users[req.session.user];
  if (!me) return res.status(404).json({ error: 'User not found' });
  const label = String(req.body.label || '').trim();
  if (!label) return res.status(400).json({ error: 'Profile name is required' });
  if (label.length > 40) return res.status(400).json({ error: 'Profile name is too long' });
  me.label = label;
  saveUsers(users);
  res.json({
    ok: true,
    username: req.session.user,
    label: me.label,
    isAdmin: !!me.isAdmin,
  });
});
app.delete('/api/share/:token', auth, (req, res) => {
  const shares = loadShares();
  const s = shares[req.params.token];
  if (s && shareOwner(s) === req.session.user) {
    delete shares[req.params.token];
    saveShares(shares);
    return res.json({ ok: true });
  }
  res.status(404).json({ error: 'Not found' });
});
app.get('/share/:token', (req, res) => {
  const shares = loadShares();
  const s = shares[req.params.token];
  if (!s) return res.status(404).send(shareNotFoundPage());
  if (shareIsExpired(s)) {
    delete shares[req.params.token];
    saveShares(shares);
    return res.status(404).send(shareNotFoundPage());
  }
  if (s.passwordHash) {
    const verified = req.session.verifiedShares && req.session.verifiedShares[req.params.token];
    if (!verified) {
      return res.send(sharePasswordPage(req.params.token));
    }
  }
  const file = shareFilePath(s);
  if (!file) return res.status(404).send(shareNotFoundPage());
  if (!fs.existsSync(file)) return res.status(404).send(shareNotFoundPage());
  
  if (s.preview && !req.query.dl) {
    const sizeBytes = fs.statSync(file).size;
    const sizeStr = sizeBytes > 1024*1024*1024 ? (sizeBytes/(1024*1024*1024)).toFixed(2)+' GB' : sizeBytes > 1024*1024 ? (sizeBytes/(1024*1024)).toFixed(2)+' MB' : sizeBytes > 1024 ? (sizeBytes/1024).toFixed(2)+' KB' : sizeBytes+' B';
    return res.send(sharePreviewPage(s, req.params.token, s.downloadName || path.basename(file), sizeStr));
  }
  s.downloads = (s.downloads || 0) + 1;
  saveShares(shares);
  res.download(file, s.downloadName || path.basename(file), { dotfiles: 'allow' });
});
app.post('/share/:token/auth', (req, res) => {
  const shares = loadShares();
  const s = shares[req.params.token];
  if (!s || shareIsExpired(s)) return res.status(404).send(shareNotFoundPage());
  
  const password = req.body.password || '';
  if (s.passwordHash && s.passwordSalt) {
    const testHash = crypto.pbkdf2Sync(password.trim(), Buffer.from(s.passwordSalt, 'hex'), 1000, 32, 'sha256').toString('hex');
    if (testHash === s.passwordHash) {
      req.session.verifiedShares = req.session.verifiedShares || {};
      req.session.verifiedShares[req.params.token] = true;
      return res.redirect('/share/' + req.params.token + (req.query.dl ? '?dl=1' : ''));
    }
  }
  
  res.send(sharePasswordPage(req.params.token, 'Неверный пароль'));
});
app.get('/api/shares', auth, (req, res) => {
  const shares = loadShares();
  const mine = Object.entries(shares)
    .filter(([, s]) => shareOwner(s) === req.session.user)
    .map(([token, s]) => ({ token, file: s.file || s.path || s.downloadName, created: shareCreated(s), expiresAt: s.expiresAt || null, downloads: s.downloads || 0, maxDownloads: s.maxDownloads || null }));
  res.json(mine);
});
// CORS helper for extension endpoints
const EXT_CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
function extCors(req, res, next) { res.set(EXT_CORS); next(); }
app.options('/api/add-ext',       (req, res) => res.set(EXT_CORS).sendStatus(204));
app.options('/api/upload-ext',    (req, res) => res.set(EXT_CORS).sendStatus(204));
app.options('/api/downloads-ext', (req, res) => res.set(EXT_CORS).sendStatus(204));
app.options('/api/files-ext',     (req, res) => res.set(EXT_CORS).sendStatus(204));
app.options('/api/ext/shares',    (req, res) => res.set(EXT_CORS).sendStatus(204));
app.options('/api/ext/share',     (req, res) => res.set(EXT_CORS).sendStatus(204));
app.options('/api/purge-errors-ext', (req, res) => res.set(EXT_CORS).sendStatus(204));
app.post('/api/add-ext', extCors, authToken, async (req, res) => {
  const dlUrl = (req.body.url || '').trim();
  const outName = filenameWithUrlExtension(dlUrl, req.body.filename || '');
  if (!dlUrl) return res.status(400).json({ error: 'URL пустой' });
  if (!isUriSafe(dlUrl)) return res.status(400).json({ error: 'URL заблокирован (приватный/локальный адрес или неподдерживаемая схема)' });
  const dir = userDir(req.tokenUser);
  try {
    const opts = { dir };
    if (outName) opts.out = outName;
    let headers = [];
    if (req.body.headers) {
      try { headers = Array.isArray(req.body.headers) ? req.body.headers : JSON.parse(req.body.headers); }
      catch { headers = []; }
    }
    headers = headers
      .filter(h => h && typeof h.name === 'string' && typeof h.value === 'string')
      .map(h => ({ name: h.name.trim(), value: h.value.replace(/[\r\n]/g, ' ').trim() }))
      .filter(h => h.name && h.value && !/^authorization$/i.test(h.name))
      .slice(0, 20);
    if (headers.length) opts.header = headers.map(h => h.name + ': ' + h.value);
    const gid = await aria2('aria2.addUri', [[dlUrl], opts]);
    res.json({ ok: true, gid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
const extUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, userDir(req.tokenUser)),
    filename: (req, file, cb) => cb(null, path.basename(Buffer.from(file.originalname || 'download.bin', 'latin1').toString('utf8'))),
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: multerFileFilter,
});
app.post('/api/upload-ext', extCors, authToken, (req, res) => {
  extUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file' });
    registerUploadedFile(req.tokenUser, req.file.filename);
    res.json({ ok: true, name: req.file.filename, size: req.file.size });
  });
});
// Очистка ошибок aria2 (удаляет записи с status=error из памяти aria2, файлы не трогает)
app.post('/api/purge-errors-ext', extCors, authToken, async (req, res) => {
  const dir = userDir(req.tokenUser);
  try {
    const stopped = await aria2('aria2.tellStopped', [0, 100]);
    const errors = stopped.filter(d => d.status === 'error' && d.dir && d.dir.startsWith(dir));
    await Promise.all(errors.map(d => aria2('aria2.removeDownloadResult', [d.gid]).catch(() => {})));
    res.json({ ok: true, removed: errors.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Активные загрузки для расширения (Bearer-auth)
app.get('/api/downloads-ext', extCors, authToken, async (req, res) => {
  const dir = userDir(req.tokenUser);
  try {
    const [active, waiting, stopped] = await Promise.all([
      aria2('aria2.tellActive'),
      aria2('aria2.tellWaiting', [0, 50]),
      aria2('aria2.tellStopped', [0, 30]),
    ]);
    const mine = [...active, ...waiting, ...stopped]
      .filter(d => d.dir && d.dir.startsWith(dir))
      .map(d => ({
        gid: d.gid, status: d.status,
        name: d.files?.[0]?.path ? path.basename(d.files[0].path) : (d.bittorrent?.info?.name || ''),
        size: parseInt(d.totalLength || 0),
        downloaded: parseInt(d.completedLength || 0),
        speed: parseInt(d.downloadSpeed || 0),
        progress: d.totalLength > 0 ? Math.round(d.completedLength / d.totalLength * 100) : 0,
      }))
      .filter(d => !(d.status === 'error' && !d.name));
    res.json(mine);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Список файлов для расширения (Bearer-auth)
app.get('/api/files-ext', extCors, authToken, (req, res) => {
  const dir = userDir(req.tokenUser);
  try {
    const files = fs.readdirSync(dir)
      .filter(name => {
        try { return fs.statSync(path.join(dir, name)).isFile(); } catch { return false; }
      })
      .map(name => {
        const s = fs.statSync(path.join(dir, name));
        return {
          name,
          size: s.size,
          mtime: s.mtime,
          path: '/' + name,
          source: isUploadedFile(req.tokenUser, name) ? 'upload' : 'download'
        };
      })
      .sort((a, b) => new Date(b.mtime) - new Date(a.mtime))
      .slice(0, 30);
    res.json(files);
  } catch { res.json([]); }
});
// Публичные ссылки файла для расширения
app.get('/api/ext/shares', extCors, authToken, (req, res) => {
  const filePath = (req.query.path || '').replace(/^\/+/, '');
  const fullPath = fmResolve(req.tokenUser, filePath);
  if (!fullPath) return res.set(EXT_CORS).status(403).json({ ok: false, links: [], error: 'Invalid path' });
  const shares = loadShares();
  const now = Date.now();
  const links = Object.entries(shares)
    .filter(([, v]) => sharePathMatches(v, req.tokenUser, filePath, fullPath) && (!v.expiresAt || new Date(v.expiresAt).getTime() > now))
    .map(([token]) => ({
      token,
      url: '/share/' + token,
      fullUrl: req.protocol + '://' + req.get('host') + '/share/' + token,
    }));
  res.set(EXT_CORS).json({ ok: true, links });
});
// Создать публичную ссылку из расширения
app.post('/api/ext/share', extCors, authToken, (req, res) => {
  const filePath = (req.body.path || '').replace(/^\/+/, '');
  const fullPath = fmResolve(req.tokenUser, filePath);
  if (!fullPath) return res.set(EXT_CORS).status(403).json({ ok: false, error: 'Invalid path' });
  if (!fs.existsSync(fullPath)) return res.set(EXT_CORS).json({ ok: false, error: 'Файл не найден' });
  const token = crypto.randomUUID();
  const shares = loadShares();
  shares[token] = { path: filePath, user: req.tokenUser, created: new Date().toISOString(), kind: 'ext-file', preview: true };
  saveShares(shares);
  const fullUrl = req.protocol + '://' + req.get('host') + '/share/' + token;
  res.set(EXT_CORS).json({ ok: true, token, url: '/share/' + token, fullUrl });
});
// Медиа-загрузка из расширения через yt-dlp (Bearer-auth)
app.options('/api/ext/media',  (req, res) => res.set(EXT_CORS).sendStatus(204));
app.post('/api/ext/media', extCors, authToken, (req, res) => {
  const dlUrl = (req.body.url || '').trim();
  const mode = ['video', 'audio', 'best'].includes(req.body.mode) ? req.body.mode : 'video';
  const filename = (req.body.filename || '').trim();
  if (!dlUrl) return res.status(400).json({ error: 'URL empty' });
  if (!isUriSafe(dlUrl)) return res.status(400).json({ error: 'URL заблокирован (приватный/локальный адрес или неподдерживаемая схема)' });
  const dir = userDir(req.tokenUser);
  ytDlpAvailable((available) => {
    if (!available) return res.status(500).json({ error: 'yt-dlp не установлен на сервере' });
    try {
      const job = startMediaJob({ username: req.tokenUser, url: dlUrl, dir, relPath: '', mode, filename });
      res.json({ ok: true, job: mediaJobPublic(job) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});
// Файловый браузер для расширения (Bearer-auth)
app.options('/api/ext/browse', (req, res) => res.set(EXT_CORS).sendStatus(204));
app.get('/api/ext/browse', extCors, authToken, (req, res) => {
  const relPath = (req.query.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const full = fmResolve(req.tokenUser, relPath);
  if (!full) return res.set(EXT_CORS).status(403).json({ error: 'Invalid path' });
  try {
    const entries = fs.readdirSync(full).map(name => {
      try {
        const s = fs.statSync(path.join(full, name));
        return { name, isDir: s.isDirectory(), size: s.isDirectory() ? 0 : s.size, mtime: s.mtime };
      } catch { return null; }
    }).filter(Boolean)
      .filter(e => !e.name.startsWith('.'))
      .sort((a, b) => (b.isDir ? 1 : 0) - (a.isDir ? 1 : 0) || a.name.localeCompare(b.name));
    res.set(EXT_CORS).json({ ok: true, path: relPath, entries });
  } catch (e) { res.set(EXT_CORS).status(500).json({ error: e.message }); }
});
// Версия расширения (без авторизации — для OTA проверки)
const EXT_VERSION = '2.11.0';
app.get('/api/ext/version', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*').json({
    version: EXT_VERSION,
    downloadUrl: req.protocol + '://' + req.get('host') + '/ext/update',
    changelog: 'Исправлены hash-пути CloudSpace, видео-превью и перехват загрузок расширением',
  });
});
// Страница обновления расширения
app.get('/ext/update', (req, res) => {
  const zipExists = fs.existsSync(path.join(__dirname, 'extension.zip'));
  const dlBtn = zipExists
    ? `<a class="btn" href="/ext/extension.zip" download>⬇ Скачать расширение v${EXT_VERSION}</a>`
    : `<p style="color:#dc2626;font-size:.82rem">Архив расширения ещё не загружен на сервер.</p>`;
  res.send(`<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Обновление расширения — v${EXT_VERSION}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#131315;color:#e5e1e4;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#1e1b26;border:1px solid #2e2a38;border-radius:18px;padding:32px;max-width:500px;width:100%;text-align:center}
h1{font-size:1.5rem;font-weight:800;margin-bottom:8px;color:#fff}.ver{display:inline-block;background:linear-gradient(135deg,#6b509a,#a083d1);color:#fff;border-radius:20px;padding:4px 14px;font-size:.85rem;font-weight:700;margin-bottom:18px}
p{color:#958ea0;line-height:1.6;margin-bottom:16px;font-size:.9rem}ol{text-align:left;color:#c9c4d4;line-height:2;font-size:.9rem;padding-left:20px;margin-bottom:20px}
a.btn{display:inline-block;background:linear-gradient(135deg,#6b509a,#a083d1);color:#fff;text-decoration:none;border-radius:10px;padding:12px 28px;font-weight:700;font-size:.95rem;margin-bottom:16px}
a.btn:hover{opacity:.88}.note{font-size:.75rem;color:#6b6573}</style></head>
<body><div class="card">
<h1>🔄 Обновление расширения</h1>
<div class="ver">v${EXT_VERSION}</div>
<p>Новая версия доступна для установки. Следуйте инструкции ниже:</p>
${dlBtn}
<ol>
  <li>Скачайте архив расширения (кнопка выше)</li>
  <li>Распакуйте его в любую папку</li>
  <li>Откройте <code style="background:#2e2a38;padding:2px 6px;border-radius:4px">chrome://extensions</code></li>
  <li>Включите <b>Режим разработчика</b> (переключатель справа)</li>
  <li>Нажмите <b>«Загрузить распакованное»</b> и выберите папку</li>
</ol>
<p class="note">Если расширение уже установлено через эту папку — просто нажмите «↻ Обновить» в chrome://extensions</p>
</div></body></html>`);
});
// Скачать zip расширения
app.get('/ext/extension.zip', (req, res) => {
  const zipPath = path.join(__dirname, 'extension.zip');
  if (!fs.existsSync(zipPath)) return res.status(404).send('Not found');
  res.download(zipPath, `sipliyfolder-extension-v${EXT_VERSION}.zip`);
});
// Одноразовые ticket-URL'ы для chrome.downloads (тот не умеет слать заголовки).
// Bearer-токен больше не должен попадать в URL/логи/history — extension сначала
// получает ticket, потом тащит файл по ?ticket=. Старый ?t= тоже принимаем для
// обратной совместимости со старыми версиями расширения.
const _extTickets = new Map();
function issueExtTicket(user, file) {
  const t = crypto.randomBytes(24).toString('base64url');
  _extTickets.set(t, { user, file, expiresAt: Date.now() + 60_000 });
  return t;
}
function consumeExtTicket(ticket, file) {
  const e = _extTickets.get(ticket);
  if (!e) return null;
  _extTickets.delete(ticket);
  if (e.expiresAt < Date.now()) return null;
  if (e.file !== file) return null;
  return e.user;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of _extTickets) if (e.expiresAt < now) _extTickets.delete(k);
}, 60_000).unref?.();

app.post('/api/ext-ticket', extCors, authToken, (req, res) => {
  const file = (req.body.file || '').toString();
  if (!file) return res.status(400).json({ error: 'file required' });
  const safeFile = path.basename(file);
  if (!safeFile) return res.status(400).json({ error: 'invalid file' });
  const ticket = issueExtTicket(req.tokenUser, safeFile);
  res.json({ ticket, url: '/api/ext-dl/' + encodeURIComponent(safeFile) + '?ticket=' + ticket });
});
app.options('/api/ext-ticket', (req, res) => res.set(EXT_CORS).sendStatus(204));

app.get('/api/ext-dl/:file', (req, res) => {
  const fileName = path.basename(req.params.file);
  let username = null;
  const ticket = (req.query.ticket || '').trim();
  if (ticket) {
    username = consumeExtTicket(ticket, fileName);
  } else {
    // legacy ?t= bearer (deprecated, оставлено для старого расширения)
    const token = (req.query.t || '').trim();
    if (token) {
      const tokens = loadTokens();
      username = tokens[token] || null;
    }
  }
  if (!username) return res.status(401).send('Unauthorized');
  const file = path.join(userDir(username), fileName);
  if (!fs.existsSync(file)) return res.status(404).send('Not found');
  res.set('Access-Control-Allow-Origin', '*');
  res.download(file);
});
app.get('/api/mytoken', auth, (req, res) => {
  const tokens = loadTokens();
  let token = Object.keys(tokens).find(t => tokens[t] === req.session.user);
  if (!token) {
    token = crypto.randomUUID();
    tokens[token] = req.session.user;
    saveTokens(tokens);
  }
  res.json({ token });
});
app.get('/api/qr', async (req, res) => {
  const data = String(req.query.data || '').trim();
  if (!data || data.length > 4096) return res.status(400).send('Bad QR data');
  try {
    const svg = await QRCode.toString(data, { type: 'svg', margin: 2, width: 260, color: { dark: '#111111', light: '#ffffff' } });
    res.type('image/svg+xml').send(svg);
  } catch (e) {
    res.status(500).send('QR error');
  }
});
app.post('/api/mytoken/reset', auth, (req, res) => {
  const tokens = loadTokens();
  Object.keys(tokens).forEach(t => { if (tokens[t] === req.session.user) delete tokens[t]; });
  const token = crypto.randomUUID();
  tokens[token] = req.session.user;
  saveTokens(tokens);
  res.json({ token });
});
// ─── User management ────────────────────────────────────────
app.get('/api/users', auth, (req, res) => {
  if (!isAdmin(req.session.user)) return res.status(403).json({ error: 'Forbidden' });
  const users = loadUsers();
  res.json(Object.entries(users).map(([u, d]) => ({ username: u, label: d.label, isAdmin: !!d.isAdmin })));
});
app.post('/api/users', auth, (req, res) => {
  if (!isAdmin(req.session.user)) return res.status(403).json({ error: 'Forbidden' });
  const { username, password, label } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Логин и пароль обязательны' });
  if (!/^[a-z0-9_]{2,32}$/.test(username)) return res.status(400).json({ error: 'Логин: только строчные буквы, цифры, _ (2–32 символа)' });
  const users = loadUsers();
  if (users[username]) return res.status(409).json({ error: 'Пользователь уже существует' });
  users[username] = { password, label: label || username, isAdmin: false };
  saveUsers(users);
  res.json({ ok: true });
});
app.delete('/api/users/:username', auth, (req, res) => {
  if (!isAdmin(req.session.user)) return res.status(403).json({ error: 'Forbidden' });
  const target = req.params.username;
  if (target === req.session.user) return res.status(400).json({ error: 'Нельзя удалить себя' });
  const users = loadUsers();
  if (!users[target]) return res.status(404).json({ error: 'Пользователь не найден' });
  delete users[target];
  saveUsers(users);
  // Токены
  const tokens = loadTokens();
  Object.keys(tokens).forEach(t => { if (tokens[t] === target) delete tokens[t]; });
  saveTokens(tokens);
  // Shares — снимаем все принадлежащие этому юзеру
  const shares = loadShares();
  Object.keys(shares).forEach(k => { if (shares[k] && shares[k].user === target) delete shares[k]; });
  saveShares(shares);
  // Uploads-реестр
  try {
    const uploads = loadUploads();
    if (uploads[target]) { delete uploads[target]; saveUploads(uploads); }
  } catch {}
  // Media jobs
  try {
    const jobs = loadMediaJobs();
    let changed = false;
    Object.keys(jobs).forEach(id => { if (jobs[id] && jobs[id].user === target) { delete jobs[id]; changed = true; } });
    if (changed) saveMediaJobs(jobs);
  } catch {}
  // Telegram-привязки
  try {
    const tg = loadTgUsers();
    let changed = false;
    Object.keys(tg).forEach(chatId => { if (tg[chatId] && tg[chatId].user === target) { delete tg[chatId]; changed = true; } });
    if (changed) saveTgUsers(tg);
  } catch {}
  // Файлы пользователя
  try {
    const userPath = path.join(DOWNLOADS_ROOT, target);
    if (fs.existsSync(userPath) && path.resolve(userPath).startsWith(path.resolve(DOWNLOADS_ROOT) + path.sep)) {
      fs.rmSync(userPath, { recursive: true, force: true });
    }
  } catch (e) { console.error('Failed to remove user dir:', e.message); }
  res.json({ ok: true });
});
app.post('/api/change-password', auth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Новый пароль минимум 6 символов' });
  const users = loadUsers();
  const me = users[req.session.user];
  if (!me) return res.status(404).json({ error: 'Пользователь не найден' });
  if (me.password !== currentPassword) return res.status(403).json({ error: 'Неверный текущий пароль' });
  me.password = newPassword;
  saveUsers(users);
  res.json({ ok: true });
});
app.get('/api/settings', auth, (req, res) => {
  res.json({
    retention: getUserRetention(req.session.user),
    tgLimit: getUserMaxTgSize(req.session.user)
  });
});
app.post('/api/settings', auth, (req, res) => {
  const s = loadSettings();
  if (req.body.retention !== undefined) {
    const v = parseInt(req.body.retention);
    if (isNaN(v) || ![0, 1, 3, 7, 30].includes(v)) return res.status(400).json({ error: 'Invalid retention' });
    if (typeof s[req.session.user] !== 'object') {
      s[req.session.user] = { retention: typeof s[req.session.user] === 'number' ? s[req.session.user] : 7 };
    }
    s[req.session.user].retention = v;
  }
  if (req.body.tgLimit !== undefined) {
    const v = parseInt(req.body.tgLimit);
    if (isNaN(v) || ![5, 10, 20, 50, 100, 200, 500, 1000, 2000].includes(v)) return res.status(400).json({ error: 'Invalid tgLimit' });
    if (typeof s[req.session.user] !== 'object') {
      s[req.session.user] = { retention: typeof s[req.session.user] === 'number' ? s[req.session.user] : 7 };
    }
    s[req.session.user].maxTgSize = v;
  }
  saveSettings(s);
  res.json({ ok: true });
});
app.get('/api/speedtest/ping', auth, (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.json({ ok: true, t: Date.now() });
});
app.get('/api/speedtest/download', auth, (req, res) => {
  const size = Math.max(256 * 1024, Math.min(parseInt(req.query.size, 10) || 8 * 1024 * 1024, 32 * 1024 * 1024));
  const chunk = Buffer.alloc(64 * 1024, 7);
  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Length': size,
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'X-Content-Type-Options': 'nosniff',
  });
  let sent = 0;
  function write() {
    while (sent < size) {
      const n = Math.min(chunk.length, size - sent);
      if (!res.write(n === chunk.length ? chunk : chunk.subarray(0, n))) {
        sent += n;
        return res.once('drain', write);
      }
      sent += n;
    }
    res.end();
  }
  write();
});
app.post('/api/speedtest/upload', auth, express.raw({ type: 'application/octet-stream', limit: '32mb' }), (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.json({ ok: true, bytes: req.body ? req.body.length : 0, t: Date.now() });
});
// ─── Upload ──────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, userDir(req.session.user)),
  filename: (req, file, cb) => {
    const name = path.basename(Buffer.from(file.originalname, 'latin1').toString('utf8')).replace(/[/\\]/g, '_');
    cb(null, name);
  },
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 * 1024 }, fileFilter: multerFileFilter });
app.post('/api/upload', auth, upload.array('files', 50), (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'Нет файлов' });
  req.files.forEach(f => registerUploadedFile(req.session.user, f.filename));
  res.json({ ok: true, files: req.files.map(f => ({ name: f.filename, size: f.size })) });
});
app.delete('/api/files/:file', auth, (req, res) => {
  const dir = userDir(req.session.user);
  const baseName = path.basename(req.params.file);
  const file = path.join(dir, baseName);
  try {
    fs.unlinkSync(file);
    removeUploadedFile(req.session.user, baseName);
    res.json({ ok: true });
  }
  catch { res.status(404).json({ error: 'Not found' }); }
});
// ─── Telegram API ─────────────────────────────────────────
app.get('/api/tg/status', auth, (req, res) => {
  const tgUsers = loadTgUsers();
  const entry = Object.entries(tgUsers).find(([, v]) => v.username === req.session.user);
  if (!entry) return res.json({ linked: false });
  res.json({ linked: true, telegramId: entry[0], connectedAt: entry[1].connectedAt, firstName: entry[1].firstName || '' });
});
app.get('/api/tg/connect-link', auth, (req, res) => {
  const tokens = loadTokens();
  const token = Object.keys(tokens).find(t => tokens[t] === req.session.user);
  if (!token) return res.status(400).json({ error: 'Нет токена. Сначала получите токен расширения.' });
  res.json({ url: `https://t.me/${TG_BOT_NAME}?start=${token}` });
});
app.post('/api/tg/unlink', auth, (req, res) => {
  const tgUsers = loadTgUsers();
  const key = Object.keys(tgUsers).find(k => tgUsers[k].username === req.session.user);
  if (key) { delete tgUsers[key]; saveTgUsers(tgUsers); }
  res.json({ ok: true });
});
app.listen(PORT, () => console.log('Running on port ' + PORT));
// ─── Telegram bot polling ─────────────────────────────────
let tgOffset = 0;
const tgPending = new Map(); // key → { fileId, fileName, fileSize, username, chatId }
const tgShareKeys = new Map(); // key → { username, dest }

async function handleTgUpdate(update) {
  if (update.callback_query) {
    return handleTgCallback(update.callback_query).catch(() => {});
  }
  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const fromId = String(msg.from.id);
  const text = (msg.text || '').trim();
  const tgUsers = loadTgUsers();
  // /start [token]
  if (text.startsWith('/start')) {
    const token = text.slice(6).trim();
    if (!token) {
      await tgSend(chatId, '👋 Это бот <b>Sipliy Folder VPS</b>.\n\nЧтобы подключить аккаунт:\n1. Откройте <a href="https://sipliyfolder.ru/cloud">sipliyfolder.ru/cloud</a>\n2. Настройки → Токен расширения → Показать\n3. Нажмите <b>Подключить Telegram</b>\n\nИли вручную: /start ВАШ_ТОКЕН');
      return;
    }
    const tokens = loadTokens();
    const username = tokens[token];
    if (!username) {
      await tgSend(chatId, '❌ Неверный токен. Проверьте в Настройках → Токен расширения на sipliyfolder.ru');
      return;
    }
    tgUsers[fromId] = { username, chatId, firstName: msg.from.first_name || '', connectedAt: new Date().toISOString() };
    saveTgUsers(tgUsers);
    const users = loadUsers();
    const label = (users[username] && users[username].label) || username;
    await tgSend(chatId, `✅ Подключено к аккаунту <b>${label}</b>!\n\nОтправляйте файлы сюда — они сохранятся в ваше хранилище на VPS.\n\n📁 Документы, фото, видео, аудио — всё принимаю.\n🔗 <a href="https://sipliyfolder.ru/cloud">Открыть хранилище</a>`);
    return;
  }
  if (text === '/status') {
    const u = tgUsers[fromId];
    if (!u) { await tgSend(chatId, '❌ Не подключён. Введите /start'); return; }
    await tgSend(chatId, `✅ Аккаунт: <b>${u.username}</b>\n📅 Подключён: ${new Date(u.connectedAt).toLocaleString('ru')}\n\nОтправьте файл — сохраню на VPS.`);
    return;
  }
  if (text === '/disconnect') {
    delete tgUsers[fromId];
    saveTgUsers(tgUsers);
    await tgSend(chatId, '🔌 Аккаунт отключён.');
    return;
  }
  const user = tgUsers[fromId];
  if (!user) {
    if (text && !text.startsWith('/')) await tgSend(chatId, '❌ Сначала подключите аккаунт: /start');
    return;
  }
  // Определяем файл из сообщения
  let fileId, fileName, fileSize = 0;
  if (msg.document) {
    fileId = msg.document.file_id;
    fileName = msg.document.file_name || ('file_' + Date.now());
    fileSize = msg.document.file_size || 0;
  } else if (msg.photo) {
    const photo = msg.photo[msg.photo.length - 1];
    fileId = photo.file_id;
    fileName = 'photo_' + Date.now() + '.jpg';
    fileSize = photo.file_size || 0;
  } else if (msg.video) {
    fileId = msg.video.file_id;
    fileName = msg.video.file_name || ('video_' + Date.now() + '.mp4');
    fileSize = msg.video.file_size || 0;
  } else if (msg.audio) {
    fileId = msg.audio.file_id;
    fileName = msg.audio.file_name || ('audio_' + Date.now() + '.mp3');
    fileSize = msg.audio.file_size || 0;
  } else if (msg.voice) {
    fileId = msg.voice.file_id;
    fileName = 'voice_' + Date.now() + '.ogg';
    fileSize = msg.voice.file_size || 0;
  }
  if (!fileId) {
    if (text && !text.startsWith('/')) await tgSend(chatId, '📁 Отправьте файл, фото, видео или аудио.');
    return;
  }

  // Check file size limits
  const maxMb = getUserMaxTgSize(user.username);
  const sizeMb = fileSize / (1024 * 1024);

  if (fileSize > 2000 * 1024 * 1024) {
    await tgSend(chatId, `❌ Ошибка: Telegram ограничивает максимальный размер загружаемого файла до 2 ГБ (2000 МБ). Ваш файл: <b>${sizeMb.toFixed(1)} МБ</b>.`);
    return;
  }

  if (fileSize > maxMb * 1024 * 1024) {
    await tgSend(chatId, `❌ Ошибка: Размер файла (<b>${sizeMb.toFixed(1)} МБ</b>) превышает установленный вами лимит (<b>${maxMb} МБ</b>).\n\nВы можете изменить лимит в <a href="https://sipliyfolder.ru/cloud">Настройках на сайте</a>.`);
    return;
  }

  // Direct download flow (no prompt)
  const statusMsg = await tgSend(chatId, `⏳ Сохраняю файл: <b>${fileName}</b>...`);
  const statusMsgId = statusMsg.result.message_id;

  try {
    const { dest, safeName, size } = await tgDoSaveFile({ fileId, fileName, username: user.username });
    
    // Generate secure in-memory shareKey for the callback
    const shareKey = Math.random().toString(36).slice(2, 8);
    tgShareKeys.set(shareKey, { username: user.username, dest });
    setTimeout(() => tgShareKeys.delete(shareKey), 30 * 60 * 1000); // 30 mins TTL

    await tgApi('editMessageText', {
      chat_id: chatId,
      message_id: statusMsgId,
      text: `✅ Сохранено в хранилище: <b>${safeName}</b>\n📦 ${fmtBytes(size)}\n\n<a href="https://sipliyfolder.ru/cloud">Открыть хранилище</a>`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔗 Создать публичную ссылку / QR', callback_data: 'tgshare:' + shareKey }]
        ]
      }
    });
  } catch (e) {
    await tgApi('editMessageText', {
      chat_id: chatId,
      message_id: statusMsgId,
      text: `❌ Ошибка загрузки <b>${fileName}</b>: ${e.message}`,
      parse_mode: 'HTML'
    });
  }
}
async function tgDoSaveFile(pending) {
  const fileInfo = await tgApi('getFile', { file_id: pending.fileId }, { timeout: 1800000 });
  const filePath = fileInfo.result.file_path;
  const dir = userDir(pending.username);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let safeName = pending.fileName.replace(/[/\\:*?"<>|]/g, '_');
  let dest = path.join(dir, safeName);
  if (fs.existsSync(dest)) {
    const ext = path.extname(safeName);
    const base = path.basename(safeName, ext);
    dest = path.join(dir, base + '_' + Date.now() + ext);
    safeName = path.basename(dest);
  }

  // If local server is used and it downloaded the file locally on the VPS
  if (filePath && (filePath.startsWith('/') || path.isAbsolute(filePath)) && fs.existsSync(filePath)) {
    console.log(`Local Telegram Bot API server download: Copying file from ${filePath} to ${dest}`);
    await fs.promises.copyFile(filePath, dest);
    try {
      await fs.promises.unlink(filePath);
      console.log(`Removed original temp file: ${filePath}`);
    } catch (err) {
      console.warn(`Could not remove temp file ${filePath}:`, err.message);
    }
    registerUploadedFile(pending.username, safeName);
    return { dest, safeName, size: fs.statSync(dest).size };
  }

  // Fallback: Download via HTTP
  let dlUrl;
  if (filePath && (filePath.startsWith('/') || path.isAbsolute(filePath))) {
    dlUrl = `http://localhost:8081/file/bot${TG_TOKEN}/${filePath}`;
  } else {
    dlUrl = `http://localhost:8081/file/bot${TG_TOKEN}/${filePath}`;
  }

  console.log(`Downloading Telegram file via HTTP from: ${dlUrl}`);
  let resp;
  try {
    resp = await axios.get(dlUrl, { responseType: 'stream', timeout: 1200000 });
  } catch (e) {
    if (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND') {
      const fallbackUrl = `https://api.telegram.org/file/bot${TG_TOKEN}/${filePath}`;
      console.warn(`Local Telegram Bot API download server not reachable, falling back to: ${fallbackUrl}`);
      resp = await axios.get(fallbackUrl, { responseType: 'stream', timeout: 1200000 });
    } else {
      throw e;
    }
  }

  const writer = fs.createWriteStream(dest);
  resp.data.pipe(writer);
  await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
  registerUploadedFile(pending.username, safeName);
  return { dest, safeName, size: fs.statSync(dest).size };
}
async function handleTgCallback(cb) {
  const chatId = cb.message.chat.id;
  const msgId = cb.message.message_id;
  const [action, key] = (cb.data || '').split(':');
  await tgApi('answerCallbackQuery', { callback_query_id: cb.id });

  if (action === 'tgshare') {
    const sharePending = tgShareKeys.get(key);
    if (!sharePending) {
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: '⏱ Время действия кнопки истекло. Ссылку можно создать на сайте.', show_alert: true });
      return;
    }
    tgShareKeys.delete(key);

    await tgApi('editMessageText', {
      chat_id: chatId,
      message_id: msgId,
      text: cb.message.text + '\n\n⏳ Создаю публичную ссылку...',
      parse_mode: 'HTML'
    });

    try {
      const username = sharePending.username;
      const dest = sharePending.dest;
      const safeName = path.basename(dest);
      
      const token = crypto.randomUUID();
      const shares = loadShares();
      const relPath = fmRelative(username, dest) || path.basename(dest);
      shares[token] = { username, file: relPath, created: new Date().toISOString(), downloads: 0, maxDownloads: null, expiresAt: null, preview: false };
      saveShares(shares);
      
      const shareUrl = `https://sipliyfolder.ru/share/${token}`;
      const qrBuf = await QRCode.toBuffer(shareUrl, { type: 'png', width: 300, margin: 2, color: { dark: '#111111', light: '#ffffff' } });
      
      const FormDataLib = require('form-data');
      const fd = new FormDataLib();
      fd.append('chat_id', String(chatId));
      fd.append('photo', qrBuf, { filename: 'qr.png', contentType: 'image/png' });
      fd.append('caption', `✅ Публичная ссылка создана!\n\n📁 <b>${safeName}</b>\n\n🔗 <a href="${shareUrl}">${shareUrl}</a>`, { contentType: 'text/plain; charset=utf-8' });
      fd.append('parse_mode', 'HTML');
      
      await tgPost('sendPhoto', fd, { timeout: 30000 });
      
      await tgApi('editMessageText', {
        chat_id: chatId,
        message_id: msgId,
        text: cb.message.text + `\n\n🔗 Ссылка: <a href="${shareUrl}">${shareUrl}</a>`,
        parse_mode: 'HTML'
      });
    } catch (e) {
      await tgSend(chatId, `❌ Ошибка создания ссылки: ${e.message}`);
    }
    return;
  }

  // Legacy callback query support
  const pending = tgPending.get(key);
  if (!pending) {
    await tgApi('editMessageText', { chat_id: chatId, message_id: msgId, text: '⏱ Время ожидания истекло. Отправьте файл ещё раз.' });
    return;
  }
  if (action === 'cancel') {
    tgPending.delete(key);
    await tgApi('editMessageText', { chat_id: chatId, message_id: msgId, text: '❌ Отменено.' });
    return;
  }
  tgPending.delete(key);
  await tgApi('editMessageText', { chat_id: chatId, message_id: msgId, text: '⏳ Загружаю файл...' });
  try {
    const { dest, safeName, size } = await tgDoSaveFile(pending);
    if (action === 'save') {
      await tgSend(chatId, `✅ Сохранено: <b>${safeName}</b>\n📦 ${fmtBytes(size)}\n\n<a href="https://sipliyfolder.ru/cloud">Открыть хранилище</a>`);
      return;
    }
    if (action === 'share') {
      const token = crypto.randomUUID();
      const shares = loadShares();
      const relPath = fmRelative(pending.username, dest) || path.basename(dest);
      shares[token] = { username: pending.username, file: relPath, created: new Date().toISOString(), downloads: 0, maxDownloads: null, expiresAt: null, preview: false };
      saveShares(shares);
      const shareUrl = `https://sipliyfolder.ru/share/${token}`;
      const qrBuf = await QRCode.toBuffer(shareUrl, { type: 'png', width: 300, margin: 2, color: { dark: '#111111', light: '#ffffff' } });
      const FormDataLib = require('form-data');
      const fd = new FormDataLib();
      fd.append('chat_id', String(chatId));
      fd.append('photo', qrBuf, { filename: 'qr.png', contentType: 'image/png' });
      fd.append('caption', `✅ <b>${safeName}</b>\n📦 ${fmtBytes(size)}\n\n🔗 <a href="${shareUrl}">${shareUrl}</a>`, { contentType: 'text/plain; charset=utf-8' });
      fd.append('parse_mode', 'HTML');
      await tgPost('sendPhoto', fd, { timeout: 30000 });
    }
  } catch (e) {
    await tgSend(chatId, `❌ Ошибка: ${e.message}`);
  }
}
async function tgPoll() {
  let hadUpdates = false;
  try {
    const r = await tgApi('getUpdates', { offset: tgOffset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
    if (r.ok && r.result && r.result.length) {
      hadUpdates = true;
      for (const upd of r.result) {
        tgOffset = upd.update_id + 1;
        handleTgUpdate(upd).catch(() => {});
      }
    }
  } catch (e) {}
  setTimeout(tgPoll, hadUpdates ? 300 : 5000);
}
tgPoll();
// ─── File Manager helper ─────────────────────────────────
function fmResolve(username, relPath) {
  if (!username) return null;
  const base = userDir(username);
  const rel = (relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const full = path.resolve(path.join(base, rel));
  const inside = path.relative(base, full);
  if (inside && (inside.startsWith('..') || path.isAbsolute(inside))) return null;
  return full;
}
function shareOwner(s) {
  return s && (s.user || s.username || null);
}
function shareCreated(s) {
  return s && (s.created || (s.createdAt ? new Date(s.createdAt).toISOString() : null));
}
function sharePathMatches(s, username, relPath, fullPath) {
  if (!s || shareOwner(s) !== username) return false;
  const stored = s.path || '';
  return stored === relPath || stored === fullPath || s.file === path.basename(relPath || fullPath || '');
}
function shareFilePath(s) {
  const owner = shareOwner(s);
  if (!owner) return null;
  if (s.path) {
    if (path.isAbsolute(s.path)) {
      const base = userDir(owner);
      const full = path.resolve(s.path);
      const inside = path.relative(base, full);
      return inside && (inside.startsWith('..') || path.isAbsolute(inside)) ? null : full;
    }
    return fmResolve(owner, s.path);
  }
  if (s.file) return path.join(userDir(owner), path.basename(s.file));
  return null;
}
function fmRelative(username, fullPath) {
  return path.relative(userDir(username), fullPath).replace(/\\/g, '/');
}
function fmDirSize(fullPath) {
  let total = 0;
  try {
    fs.readdirSync(fullPath, { withFileTypes: true }).forEach(entry => {
      const child = path.join(fullPath, entry.name);
      try {
        if (entry.isDirectory()) total += fmDirSize(child);
        else total += fs.statSync(child).size;
      } catch {}
    });
  } catch {}
  return total;
}
function fmArchiveDir(username) {
  const dir = path.join(userDir(username), '.archives');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function fmCollectItems(username, items) {
  const base = userDir(username);
  const seen = new Set();
  const out = [];
  (Array.isArray(items) ? items : [items]).forEach(item => {
    const relRaw = typeof item === 'string' ? item : (item && (item.path || item.fp));
    const full = fmResolve(username, relRaw || '');
    if (!full || full === base || !fs.existsSync(full)) return;
    const rel = fmRelative(username, full);
    if (!rel || rel.startsWith('.archives/') || seen.has(rel)) return;
    const stat = fs.statSync(full);
    seen.add(rel);
    out.push({ rel, full, isDir: stat.isDirectory(), name: path.basename(full) });
  });
  return out;
}
function fmZipItems(username, items, downloadName, cb, shareOptions) {
  const picked = fmCollectItems(username, items);
  if (!picked.length) return cb(new Error('No files'));
  const token = crypto.randomUUID();
  const archiveRel = '.archives/' + token + '.zip';
  const archivePath = path.join(fmArchiveDir(username), token + '.zip');
  const output = fs.createWriteStream(archivePath);
  const archive = archiver('zip', { zlib: { level: 6 } });
  let done = false;
  const finish = (err) => {
    if (done) return;
    done = true;
    if (err) { try { fs.unlinkSync(archivePath); } catch {} return cb(err); }
    const shares = loadShares();
    shares[token] = Object.assign({
      path: archiveRel,
      user: username,
      downloadName: downloadName || 'cloudspace.zip',
      created: new Date().toISOString(),
      kind: 'zip',
    }, shareOptions || {});
    saveShares(shares);
    cb(null, { token, url: '/share/' + token, count: picked.length });
  };
  output.on('close', () => finish(null));
  output.on('error', finish);
  archive.on('error', finish);
  archive.pipe(output);
  for (const it of picked) {
    if (it.isDir) archive.directory(it.full, it.name);
    else archive.file(it.full, { name: it.name });
  }
  archive.finalize().catch(finish);
}
function fmArchiveEntryName(entryPath) {
  return path.basename(String(entryPath || '').replace(/\\/g, '/')) || 'archive-entry';
}
function fmParse7zList(stdout, archivePath) {
  const entries = [];
  let cur = null;
  String(stdout || '').split(/\r?\n/).forEach(line => {
    const m = line.match(/^([^=]+) = (.*)$/);
    if (!m) return;
    const key = m[1].trim();
    const val = m[2];
    if (key === 'Path') {
      if (cur && cur.path && cur.path !== cur.archivePath) entries.push(cur);
      cur = { path: val };
      return;
    }
    if (!cur) return;
    if (key === 'Size') cur.size = parseInt(val, 10) || 0;
    else if (key === 'Packed Size') cur.packedSize = parseInt(val, 10) || 0;
    else if (key === 'Modified') cur.modified = val;
    else if (key === 'Attributes') cur.isDir = val.indexOf('D') !== -1;
  });
  if (cur && cur.path && cur.path !== cur.archivePath) entries.push(cur);
  const archiveBase = path.basename(archivePath || '');
  return entries
    .filter(x => x.path && x.path !== archivePath && x.path !== archiveBase && !x.path.endsWith('/'))
    .map(x => ({
      path: x.path,
      name: fmArchiveEntryName(x.path),
      size: x.size || 0,
      packedSize: x.packedSize || 0,
      modified: x.modified || null,
      isDir: !!x.isDir,
    }));
}
function fmRun7z(args, cb) {
  execFile('7z', args, { timeout: 120000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (!err) return cb(null, stdout);
    execFile('7zz', args, { timeout: 120000, maxBuffer: 16 * 1024 * 1024 }, (err2, stdout2, stderr2) => {
      if (!err2) return cb(null, stdout2);
      const e = new Error((stderr2 || stderr || err2.message || err.message || '7z failed').trim());
      e.code = err2.code || err.code;
      cb(e);
    });
  });
}
// GET /api/fm/list?path=
app.get('/api/fm/list', auth, (req, res) => {
  const full = fmResolve(req.session.user, req.query.path || '');
  if (!full) return res.status(403).json({ error: 'Invalid path' });
  try {
    let diskUsed = null, diskTotal = null;
    try {
      const sf = fs.statfsSync(full);
      diskTotal = sf.blocks * sf.bsize;
      diskUsed  = (sf.blocks - sf.bfree) * sf.bsize;
    } catch {}
    const entries = fs.readdirSync(full)
      .filter(n => !n.startsWith('.'))
      .map(name => {
        const p = path.join(full, name);
        const stat = fs.statSync(p);
        const isDir = stat.isDirectory();
        let fileCount = 0;
        if (isDir) { try { fileCount = fs.readdirSync(p).filter(n => !n.startsWith('.')).length; } catch {} }
        return { name, isDir, size: isDir ? 0 : stat.size, mtime: stat.mtime, fileCount };
      })
      .sort((a, b) => { if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; return a.name.localeCompare(b.name, 'ru'); });
    res.json({ entries, diskUsed, diskTotal });
  } catch { res.json({ entries: [], diskUsed: null, diskTotal: null }); }
});
// POST /api/fm/mkdir  body: { path, name }
app.post('/api/fm/mkdir', auth, (req, res) => {
  const parentRel = req.body.path || '';
  const name = (req.body.name || '').trim().replace(/[/\\]/g, '');
  if (!name) return res.status(400).json({ error: 'Не указано имя' });
  const combined = parentRel ? (parentRel + '/' + name) : name;
  const full = fmResolve(req.session.user, combined);
  if (!full) return res.status(403).json({ error: 'Invalid path' });
  if (fs.existsSync(full)) return res.status(409).json({ error: 'Уже существует' });
  try {
    fs.mkdirSync(full, { recursive: true });
    logActivity(req.session.user, 'Создание папки', 'Создана папка: ' + combined);
    res.json({ ok: true });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// POST /api/fm/rename  body: { oldPath, newName }
app.post('/api/fm/rename', auth, (req, res) => {
  const oldPath = req.body.oldPath || '';
  const newName = (req.body.newName || '').trim().replace(/[/\\]/g, '');
  if (!oldPath || !newName) return res.status(400).json({ error: 'Неверные параметры' });
  const from = fmResolve(req.session.user, oldPath);
  if (!from) return res.status(403).json({ error: 'Invalid path' });
  if (!fs.existsSync(from)) return res.status(404).json({ error: 'Not found' });
  const stat = fs.statSync(from);
  let finalName = newName;
  if (!stat.isDirectory()) {
    const oldBase = path.basename(oldPath);
    const dot = oldBase.lastIndexOf('.');
    const oldExt = dot > 0 ? oldBase.slice(dot) : '';
    if (oldExt) {
      finalName = newName.toLowerCase().endsWith(oldExt.toLowerCase())
        ? newName.slice(0, -oldExt.length) + oldExt
        : newName + oldExt;
    }
  }
  const dir = path.dirname(oldPath);
  const toRel = (dir === '.' || dir === '') ? finalName : (dir + '/' + finalName);
  const to   = fmResolve(req.session.user, toRel);
  if (!to) return res.status(403).json({ error: 'Invalid path' });
  if (fs.existsSync(to)) return res.status(409).json({ error: 'Уже существует' });
  try {
    fs.renameSync(from, to);
    logActivity(req.session.user, 'Переименование', 'Переименован объект ' + oldPath + ' в ' + toRel);
    res.json({ ok: true });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// DELETE /api/fm/delete  body: { path }
app.delete('/api/fm/delete', auth, (req, res) => {
  const targetRel = req.body.path || req.query.path || '';
  const full = fmResolve(req.session.user, targetRel);
  if (!full) return res.status(403).json({ error: 'Invalid path' });
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'Not found' });
  try {
    const stat = fs.statSync(full);
    const baseName = path.basename(full);
    if (stat.isDirectory()) {
      fs.rmSync(full, { recursive: true, force: true });
    } else {
      fs.unlinkSync(full);
      removeUploadedFile(req.session.user, baseName);
    }
    logActivity(req.session.user, 'Удаление', 'Удален объект: ' + targetRel);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// POST /api/fm/move  body: { from, to }
// POST /api/fm/video-screenshot  body: { path, folder, img }
app.post('/api/fm/video-screenshot', auth, (req, res) => {
  const videoRelPath = req.body.path || '';
  const folderRelPath = req.body.folder || '';
  const base64Data = req.body.img || '';
  
  if (!videoRelPath || !base64Data) {
    return res.status(400).json({ error: 'Неверные параметры' });
  }
  
  const videoAbsPath = fmResolve(req.session.user, videoRelPath);
  if (!videoAbsPath || !fs.existsSync(videoAbsPath)) {
    return res.status(404).json({ error: 'Видеофайл не найден' });
  }
  
  const folderAbsPath = fmResolve(req.session.user, folderRelPath);
  if (!folderAbsPath || !fs.existsSync(folderAbsPath)) {
    return res.status(404).json({ error: 'Папка не найдена' });
  }
  
  try {
    const videoBase = path.basename(videoAbsPath, path.extname(videoAbsPath));
    const cleanVideoBase = videoBase.replace(/[^a-zA-Z0-9а-яА-ЯёЁ_ -]/g, '');
    const ts = new Date().toISOString().replace(/T/, '_').replace(/\..+/, '').replace(/:/g, '-');
    const screenshotName = `${cleanVideoBase}_frame_${ts}.png`;
    const screenshotAbsPath = path.join(folderAbsPath, screenshotName);
    
    const rawData = base64Data.replace(/^data:image\/png;base64,/, "");
    const buffer = Buffer.from(rawData, 'base64');
    
    fs.writeFileSync(screenshotAbsPath, buffer);
    
    const screenshotRelPath = folderRelPath ? (folderRelPath + '/' + screenshotName) : screenshotName;
    logActivity(req.session.user, 'Скриншот', 'Сохранён кадр видео в ' + screenshotRelPath);
    
    res.json({ ok: true, name: screenshotName });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сохранения кадра: ' + err.message });
  }
});
app.post('/api/fm/move', auth, (req, res) => {
  const from = fmResolve(req.session.user, req.body.from);
  const to   = fmResolve(req.session.user, req.body.to);
  if (!from || !to) return res.status(403).json({ error: 'Invalid path' });
  if (!fs.existsSync(from)) return res.status(404).json({ error: 'Not found' });
  if (from === to) return res.json({ ok: true });
  if (fs.existsSync(to)) return res.status(409).json({ error: 'Уже существует' });
  try {
    const stat = fs.statSync(from);
    if (stat.isDirectory()) {
      const inside = path.relative(from, to);
      if (inside && !inside.startsWith('..') && !path.isAbsolute(inside)) {
        return res.status(400).json({ error: 'Нельзя переместить папку внутрь самой себя' });
      }
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  try {
    fs.renameSync(from, to);
    logActivity(req.session.user, 'Перемещение', 'Перемещен объект из ' + req.body.from + ' в ' + req.body.to);
    res.json({ ok: true });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// GET /api/fm/recent
app.get('/api/fm/recent', auth, (req, res) => {
  const base = userDir(req.session.user);
  const results = [];
  function walk(dir, relDir) {
    try {
      fs.readdirSync(dir).filter(n => !n.startsWith('.')).forEach(name => {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        const rel = (relDir ? relDir + '/' : '') + name;
        if (stat.isDirectory()) walk(full, rel);
        else results.push({ name, relPath: rel, size: stat.size, mtime: stat.mtime });
      });
    } catch {}
  }
  walk(base, '');
  results.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
  res.json({ entries: results.slice(0, 50) });
});
// GET /api/activity
app.get('/api/activity', auth, (req, res) => {
  res.json(loadActivity());
});
// GET /api/fm/search?q=
app.get('/api/fm/search', auth, (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json({ entries: [] });
  const base = userDir(req.session.user);
  const results = [];
  function walk(dir, relDir) {
    try {
      fs.readdirSync(dir).filter(n => !n.startsWith('.')).forEach(name => {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        const rel = (relDir ? relDir + '/' : '') + name;
        const isDir = stat.isDirectory();
        if (name.toLowerCase().includes(q)) results.push({ name, relPath: rel, isDir, size: isDir ? 0 : stat.size, mtime: stat.mtime });
        if (isDir) walk(full, rel);
      });
    } catch {}
  }
  walk(base, '');
  res.json({ entries: results.slice(0, 100) });
});
// GET /api/fm/download?path=
app.get('/api/fm/download', auth, (req, res) => {
  const relPath = req.query.path || '';
  const full = fmResolve(req.session.user, relPath);
  if (!full || !fs.existsSync(full)) return res.status(404).send('Not found');
  const stats = fs.statSync(full);
  if (stats.isDirectory()) {
    logActivity(req.session.user, 'Скачивание', 'Скачана папка как ZIP: ' + relPath);
    const archiveName = (path.basename(full) || 'folder') + '.zip';
    res.attachment(archiveName);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      console.error('Directory archiving error:', err);
      if (!res.headersSent) {
        res.status(500).send({ ok: false, error: err.message });
      }
    });
    archive.pipe(res);
    archive.directory(full, false);
    archive.finalize();
  } else {
    logActivity(req.session.user, 'Скачивание', 'Скачан файл: ' + relPath);
    res.download(full, path.basename(full));
  }
});
// GET /api/fm/preview?path=
app.get('/api/fm/preview', auth, (req, res) => {
  const full = fmResolve(req.session.user, req.query.path || '');
  if (!full || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return res.status(404).send('Not found');
  const ext = path.extname(full).toLowerCase();
  if (ext === '.exe') {
    const os = require('os');
    const tmpFile = path.join(os.tmpdir(), 'icon-' + Date.now() + '-' + Math.random().toString(36).substring(7) + '.ico');
    execFile('wrestool', ['-l', '-t', '14', full], (err, stdout) => {
      if (err || !stdout) return res.status(404).send('Icon not found');
      const match = stdout.match(/--name=(?:"([^"]+)"|([^\s]+))/);
      const name = match ? (match[1] || match[2]) : null;
      if (!name) return res.status(404).send('Icon not found');
      execFile('wrestool', ['-x', '-t', '14', '--name=' + name, full], { encoding: 'buffer' }, (err, stdoutBuffer) => {
        if (err || !stdoutBuffer) return res.status(404).send('Icon extraction failed');
        fs.writeFile(tmpFile, stdoutBuffer, (err) => {
          if (err) return res.status(500).send('Save failed');
          res.sendFile(tmpFile, { headers: { 'Content-Type': 'image/x-icon' } }, () => {
            try { fs.unlinkSync(tmpFile); } catch {}
          });
        });
      });
    });
    return;
  }
  const mediaExt = new Set(['.mp4','.webm','.ogg','.mov','.mkv','.m4v','.avi','.flv', '.jpg','.jpeg','.png','.webp','.bmp']);
  if (mediaExt.has(ext) && req.query.thumb === '1') {
    const os = require('os');
    const hash = crypto.createHash('md5').update(full).digest('hex');
    const thumbPath = path.join(os.tmpdir(), `vps_thumb_${hash}.jpg`);
    if (fs.existsSync(thumbPath)) return res.sendFile(thumbPath, { headers: { 'Content-Type': 'image/jpeg' } });
    const isVideo = ['.mp4','.webm','.ogg','.mov','.mkv','.m4v','.avi','.flv'].includes(ext);
    if (!isVideo && fs.statSync(full).size < 1024 * 500) return res.sendFile(full);
    const runThumb = (args, fallback) => {
      execFile('ffmpeg', args, { timeout: 20000 }, () => {
        if (fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 0) {
          return res.sendFile(thumbPath, { headers: { 'Content-Type': 'image/jpeg' } });
        }
        if (fallback) return fallback();
        if (isVideo) return res.status(404).send('Thumb failed');
        return res.sendFile(full);
      });
    };
    const baseArgs = ['-y', '-hide_banner', '-loglevel', 'error', '-i', full, '-frames:v', '1', '-vf', 'scale=320:-1', '-q:v', '5', thumbPath];
    if (isVideo) {
      runThumb(['-y', '-hide_banner', '-loglevel', 'error', '-ss', '00:00:00.2', '-i', full, '-frames:v', '1', '-vf', 'scale=320:-1', '-q:v', '5', thumbPath], () => {
        runThumb(baseArgs, null);
      });
    } else {
      runThumb(baseArgs, null);
    }
    return;
  }
  if (['.mp4','.webm','.ogg','.mov','.mkv','.m4v'].includes(ext)) {
    const quality = req.query.quality;
    if (quality && ['360', '480', '720'].includes(quality)) {
      const height = parseInt(quality, 10);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Cache-Control', 'no-cache');
      const { spawn } = require('child_process');
      console.log(`Transcoding video ${full} to ${quality}p`);
      const ffmpeg = spawn('ffmpeg', [
        '-y',
        '-hide_banner',
        '-loglevel', 'error',
        '-i', full,
        '-vf', `scale=-2:${height}`,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'fastdecode',
        '-threads', '1',
        '-crf', '28',
        '-c:a', 'copy',
        '-f', 'mp4',
        '-movflags', 'frag_keyframe+empty_moov',
        'pipe:1'
      ]);
      ffmpeg.stdout.pipe(res);
      ffmpeg.on('error', (err) => {
        console.error('Failed to start ffmpeg transcoding process:', err);
      });
      req.on('close', () => {
        console.log(`Killing transcoding child process for ${quality}p`);
        ffmpeg.kill('SIGKILL');
      });
      return;
    }
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const typeMap = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.ogg': 'video/ogg', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska' };
    const stat = fs.statSync(full);
    const range = req.headers.range;
    if (range) {
      const m = String(range).match(/bytes=(\d*)-(\d*)/);
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
        if (start <= end && start < stat.size) {
          res.status(206);
          res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
          res.setHeader('Content-Length', end - start + 1);
          res.setHeader('Content-Type', typeMap[ext] || 'application/octet-stream');
          fs.createReadStream(full, { start, end }).pipe(res);
          return;
        }
      }
    }
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Type', typeMap[ext] || 'application/octet-stream');
    fs.createReadStream(full).pipe(res);
    return;
  }
  const textExt = new Set(['.txt','.log','.md','.json','.csv','.js','.css','.html','.xml','.yml','.yaml','.ini','.conf']);
  if (textExt.has(ext)) {
    const max = 1024 * 1024;
    const buf = fs.readFileSync(full);
    res.type('text/plain').send(buf.slice(0, max).toString('utf8') + (buf.length > max ? '\n\n... trimmed ...' : ''));
    return;
  }
  res.sendFile(full);
});
app.get('/api/fm/doc-preview', auth, async (req, res) => {
  const full = fmResolve(req.session.user, req.query.path || '');
  if (!full || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return res.status(404).json({ error: 'Not found' });
  const ext = path.extname(full).toLowerCase();
  try {
    if (ext === '.docx') {
      let mammoth;
      try { mammoth = require('mammoth'); }
      catch { return res.status(501).json({ error: 'mammoth dependency is not installed' }); }
      const out = await mammoth.convertToHtml({ path: full }, {
        styleMap: [
          "p[style-name='Title'] => h1:fresh",
          "p[style-name='Subtitle'] => h2:fresh",
        ],
      });
      return res.json({ ok: true, type: 'docx', html: out.value || '<p></p>', messages: out.messages || [] });
    }
    if (['.xlsx', '.csv'].includes(ext)) {
      let ExcelJS;
      try { ExcelJS = require('exceljs'); }
      catch { return res.status(501).json({ error: 'exceljs dependency is not installed' }); }
      const wb = new ExcelJS.Workbook();
      if (ext === '.csv') await wb.csv.readFile(full);
      else await wb.xlsx.readFile(full);
      const sheets = wb.worksheets.slice(0, 8).map(ws => {
        let html = '<table><tbody>';
        const maxRow = Math.min(ws.rowCount, 120);
        const maxCol = Math.min(ws.columnCount, 40);
        for (let r = 1; r <= maxRow; r++) {
          html += '<tr>';
          const row = ws.getRow(r);
          for (let c = 1; c <= maxCol; c++) {
            const cell = row.getCell(c);
            const raw = cell.text || (cell.value == null ? '' : String(cell.value));
            html += '<td>' + String(raw).replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch])) + '</td>';
          }
          html += '</tr>';
        }
        html += '</tbody></table>';
        return { name: ws.name || 'Sheet', html };
      });
      return res.json({ ok: true, type: 'sheet', sheets });
    }
    return res.status(415).json({ error: 'Unsupported document type' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Preview failed' });
  }
});
app.get('/api/fm/archive/list', auth, (req, res) => {
  const full = fmResolve(req.session.user, req.query.path || '');
  if (!full || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return res.status(404).json({ error: 'Not found' });
  const ext = path.extname(full).toLowerCase();
  if (!['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz'].includes(ext)) return res.status(415).json({ error: 'Unsupported archive type' });
  fmRun7z(['l', '-slt', full], (err, stdout) => {
    if (err) return res.status(501).json({ error: '7z is not installed or cannot read this archive', details: err.message });
    const entries = fmParse7zList(stdout, full).slice(0, 2000);
    res.json({ ok: true, entries });
  });
});
app.get('/api/fm/archive/download', auth, (req, res) => {
  const full = fmResolve(req.session.user, req.query.path || '');
  const entry = String(req.query.entry || '');
  if (!full || !fs.existsSync(full) || fs.statSync(full).isDirectory() || !entry) return res.status(404).send('Not found');
  if (path.isAbsolute(entry) || entry.includes('..')) return res.status(403).send('Invalid archive entry');
  const filename = fmArchiveEntryName(entry);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(filename).replace(/%/g, '') + '"; filename*=UTF-8\'\'' + encodeURIComponent(filename));
  const child = spawn('7z', ['x', '-so', full, entry], { stdio: ['ignore', 'pipe', 'pipe'] });
  let failed = false;
  child.on('error', () => {
    if (res.headersSent) return res.destroy();
    failed = true;
    res.status(501).send('7z is not installed');
  });
  child.stderr.on('data', () => {});
  child.stdout.pipe(res);
  child.on('close', code => {
    if (code !== 0 && !failed) res.destroy();
  });
});
app.get('/api/fm/meta', auth, (req, res) => {
  const rel = req.query.path || '';
  const full = fmResolve(req.session.user, rel);
  if (!full || !fs.existsSync(full)) return res.status(404).json({ error: 'Not found' });
  try {
    const stat = fs.statSync(full);
    const shares = loadShares();
    const publicLinks = Object.entries(shares)
      .filter(([, s]) => sharePathMatches(s, req.session.user, rel, full))
      .map(([token, s]) => ({
        token,
        url: '/share/' + token,
        created: shareCreated(s),
        expiresAt: s.expiresAt || null,
        downloads: s.downloads || 0,
        maxDownloads: s.maxDownloads || null,
        kind: s.kind || 'file',
      }));
    res.json({
      name: path.basename(full),
      path: rel,
      isDir: stat.isDirectory(),
      size: stat.isDirectory() ? 0 : stat.size,
      mtime: stat.mtime,
      created: stat.birthtime,
      ext: path.extname(full).toLowerCase(),
      publicLinks,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// POST /api/fm/add-url  body: { url, path, filename }
app.post('/api/fm/add-url', auth, async (req, res) => {
  const dlUrl = (req.body.url || '').trim();
  const relPath = req.body.path || '';
  const outName = filenameWithUrlExtension(dlUrl, req.body.filename || '');
  if (!dlUrl) return res.status(400).json({ error: 'URL empty' });
  if (!isUriSafe(dlUrl)) return res.status(400).json({ error: 'URL заблокирован (приватный/локальный адрес или неподдерживаемая схема)' });
  const dir = fmResolve(req.session.user, relPath);
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return res.status(403).json({ error: 'Invalid path' });
  try {
    const opts = { dir };
    if (outName) opts.out = outName;
    const gid = await aria2('aria2.addUri', [[dlUrl], opts]);
    const jobs = loadMediaJobs();
    jobs[gid] = {
      id: gid,
      user: req.session.user,
      url: dlUrl,
      mode: 'file',
      status: 'active',
      progress: 0,
      speed: '',
      eta: '',
      name: outName || dlUrl.split(/[?#]/)[0].split('/').pop() || 'File download',
      file: '',
      folder: relPath || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAtMs: Date.now(),
      error: '',
    };
    saveMediaJobs(jobs);
    logActivity(req.session.user, 'Загрузка по ссылке', 'Добавлена задача скачивания URL: ' + dlUrl + (relPath ? ' в ' + relPath : ''));
    res.json({ ok: true, gid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/media/capabilities', auth, (req, res) => {
  ytDlpAvailable((available, version) => res.json({ ok: true, available, version }));
});
app.post('/api/fm/media', auth, (req, res) => {
  const dlUrl = (req.body.url || '').trim();
  const relPath = req.body.path || '';
  const mode = ['video', 'audio', 'best'].includes(req.body.mode) ? req.body.mode : 'video';
  const filename = (req.body.filename || '').trim();
  if (!dlUrl) return res.status(400).json({ error: 'URL empty' });
  if (!isUriSafe(dlUrl)) return res.status(400).json({ error: 'URL заблокирован (приватный/локальный адрес или неподдерживаемая схема)' });
  const dir = fmResolve(req.session.user, relPath);
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return res.status(403).json({ error: 'Invalid path' });
  ytDlpAvailable((available) => {
    if (!available) return res.status(500).json({ error: 'yt-dlp is not installed on server' });
    try {
      const job = startMediaJob({ username: req.session.user, url: dlUrl, dir, relPath, mode, filename });
      logActivity(req.session.user, 'Загрузка по ссылке', 'Добавлена медиа-задача (' + mode + '): ' + dlUrl + (relPath ? ' в ' + relPath : ''));
      res.json({ ok: true, job: mediaJobPublic(job) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});
app.get('/api/fm/media-jobs', auth, async (req, res) => {
  const synced = await syncAriaDownloadJobs(req.session.user);
  const jobs = synced.jobs;
  const activeStatuses = new Set(['starting', 'active', 'processing']);
  const scope = req.query.scope || 'all';
  const mine = Object.values(jobs)
    .filter(j => j.user === req.session.user)
    .filter(j => scope === 'active' ? (j.mode !== 'file' && activeStatuses.has(j.status)) : true)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt))
    .slice(0, scope === 'active' ? 20 : 100)
    .map(mediaJobPublic);
  res.json(mine);
});
app.delete('/api/fm/media-jobs/:id', auth, (req, res) => {
  const jobs = loadMediaJobs();
  const job = jobs[req.params.id];
  if (!job || job.user !== req.session.user) return res.status(404).json({ error: 'Not found' });
  const child = mediaProcesses.get(req.params.id);
  if (child) {
    try { child.kill('SIGTERM'); } catch {}
    mediaProcesses.delete(req.params.id);
  }
  job.status = 'cancelled';
  job.updatedAt = new Date().toISOString();
  jobs[req.params.id] = job;
  saveMediaJobs(jobs);
  res.json({ ok: true });
});
// POST /api/fm/zip  body: { items, name }
app.post('/api/fm/zip', auth, (req, res) => {
  const archiveName = (req.body.name || 'cloudspace.zip').trim();
  const items = req.body.items || [];
  fmZipItems(req.session.user, items, archiveName, (err, z) => {
    if (err) return res.status(400).json({ error: err.message });
    logActivity(req.session.user, 'Архивация', 'Создан архив ' + archiveName + ' (' + items.length + ' объектов)');
    res.json({ ok: true, token: z.token, url: z.url, count: z.count });
  });
});
// POST /api/fm/share  body: { path } or { items }
app.post('/api/fm/share', auth, (req, res) => {
  const items = req.body.items || (req.body.path ? [{ path: req.body.path }] : []);
  const picked = fmCollectItems(req.session.user, items);
  if (!picked.length) return res.status(400).json({ error: 'No files' });
  const shareOptions = shareOptionsFromBody(req.body);
  if (picked.length === 1 && !picked[0].isDir) {
    const token = crypto.randomUUID();
    const shares = loadShares();
    shares[token] = Object.assign({ path: picked[0].rel, user: req.session.user, created: new Date().toISOString(), kind: 'fm-file' }, shareOptions);
    saveShares(shares);
    logActivity(req.session.user, 'Доступ', 'Создана ссылка доступа для ' + picked[0].rel);
    return res.json({ ok: true, token, url: '/share/' + token });
  }
  fmZipItems(req.session.user, picked.map(x => x.rel), 'cloudspace-share.zip', (err, z) => {
    if (err) return res.status(400).json({ error: err.message });
    logActivity(req.session.user, 'Доступ', 'Создана ссылка доступа (архив) для ' + picked.length + ' объектов');
    res.json({ ok: true, token: z.token, url: z.url, archived: true, count: z.count });
  }, shareOptions);
});
app.get('/api/fm/shares', auth, (req, res) => {
  const picked = fmCollectItems(req.session.user, [{ path: req.query.path || '' }]);
  if (!picked.length || picked[0].isDir) return res.status(400).json({ error: 'No file' });
  const rel = picked[0].rel;
  const shares = loadShares();
  const list = Object.entries(shares)
    .filter(([, s]) => sharePathMatches(s, req.session.user, rel, picked[0].full))
    .map(([token, s]) => ({
      token,
      url: '/share/' + token,
      created: shareCreated(s),
      expiresAt: s.expiresAt || null,
      downloads: s.downloads || 0,
      maxDownloads: s.maxDownloads || null,
      preview: s.preview !== false,
      hasPassword: !!s.passwordHash,
    }))
    .sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0));
  res.json({ ok: true, path: rel, shares: list });
});
app.patch('/api/fm/share/:token', auth, (req, res) => {
  const shares = loadShares();
  const share = shares[req.params.token];
  if (!share || shareOwner(share) !== req.session.user) return res.status(404).json({ error: 'Not found' });
  const maxDownloadsRaw = parseInt(req.body.maxDownloads, 10);
  const expiresInRaw = parseInt(req.body.expiresIn, 10);
  share.maxDownloads = Number.isFinite(maxDownloadsRaw) && maxDownloadsRaw > 0 ? maxDownloadsRaw : null;
  share.expiresAt = Number.isFinite(expiresInRaw) && expiresInRaw > 0 ? new Date(Date.now() + expiresInRaw * 60 * 60 * 1000).toISOString() : null;
  share.preview = !!req.body.preview;
  
  if (req.body.password !== undefined) {
    if (typeof req.body.password === 'string' && req.body.password.trim().length > 0) {
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = crypto.pbkdf2Sync(req.body.password.trim(), Buffer.from(salt, 'hex'), 1000, 32, 'sha256').toString('hex');
      share.passwordHash = hash;
      share.passwordSalt = salt;
    } else {
      delete share.passwordHash;
      delete share.passwordSalt;
    }
  }
  shares[req.params.token] = share;
  saveShares(shares);
  res.json({
    ok: true,
    token: req.params.token,
    url: '/share/' + req.params.token,
    created: shareCreated(share),
    expiresAt: share.expiresAt || null,
    downloads: share.downloads || 0,
    maxDownloads: share.maxDownloads || null,
    preview: share.preview !== false,
    hasPassword: !!share.passwordHash,
  });
});
// POST /api/fm/upload?path=
const fmUploader = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const fp = fmResolve(req.session.user, req.query.path || '');
      if (!fp) return cb(new Error('Invalid path'));
      if (!fs.existsSync(fp)) fs.mkdirSync(fp, { recursive: true });
      cb(null, fp);
    },
    filename: (req, file, cb) => cb(null, path.basename(Buffer.from(file.originalname, 'latin1').toString('utf8')).replace(/[/\\]/g, '_')),
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: multerFileFilter,
});
app.post('/api/fm/upload', auth, (req, res) => {
  fmUploader.array('files', 50)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'Нет файлов' });
    req.files.forEach(f => registerUploadedFile(req.session.user, f.filename));
    const fileNames = req.files.map(f => f.filename).join(', ');
    logActivity(req.session.user, 'Загрузка с ПК', 'Загружено ' + req.files.length + ' файл(ов): ' + fileNames);
    res.json({ ok: true, files: req.files.map(f => ({ name: f.filename, size: f.size })) });
  });
});
app.get('/cloud', auth, (req, res) => res.send(cloudPage(req.session.user)));
function runCleanup() {
  Object.keys(loadUsers()).forEach(function(username) {
    const retention = getUserRetention(username);
    if (retention === 0) return;
    const root = path.join(DOWNLOADS_ROOT, username);
    if (!fs.existsSync(root)) return;
    const cutoff = Date.now() - retention * 24 * 60 * 60 * 1000;
    function walk(dir) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        // Не трогаем служебные share-архивы — у них отдельный жизненный цикл.
        if (full.startsWith(path.join(root, '.archives'))) continue;
        try {
          if (ent.isDirectory()) {
            walk(full);
            // Пустую папку после чистки удалить.
            try {
              const left = fs.readdirSync(full);
              if (!left.length) fs.rmdirSync(full);
            } catch {}
          } else {
            if (fs.statSync(full).mtimeMs < cutoff) {
              fs.unlinkSync(full);
              const rel = path.relative(root, full).replace(/\\/g, '/');
              removeUploadedFile(username, rel);
              removeUploadedFile(username, ent.name);
            }
          }
        } catch {}
      }
    }
    walk(root);
  });
}
setInterval(runCleanup, 60 * 60 * 1000);
runCleanup();
function sharePasswordPage(token, errorMsg = '') {
  return '<!DOCTYPE html><html lang="ru"><head><title>Защищенная ссылка</title>' + HEAD + '</head>' +
  '<body class="bg-background font-body text-on-surface min-h-screen flex items-center justify-center">' +
  '<div class="absolute inset-0 overflow-hidden pointer-events-none">' +
    '<div class="absolute -top-40 -right-40 w-96 h-96 bg-primary/5 rounded-full blur-3xl"></div>' +
    '<div class="absolute -bottom-40 -left-40 w-96 h-96 bg-primary-container/10 rounded-full blur-3xl"></div>' +
  '</div>' +
  '<div class="relative w-full max-w-sm mx-4">' +
    '<div class="bg-surface-container-lowest/80 glass rounded-4xl p-10 shadow-[0_32px_80px_rgba(107,80,154,0.08)] text-center">' +
      '<div class="w-14 h-14 mx-auto rounded-3xl bg-gradient-to-tr from-primary to-primary-container flex items-center justify-center shadow-lg shadow-purple-200 mb-6">' +
        '<span class="material-symbols-outlined text-white text-2xl">lock</span>' +
      '</div>' +
      '<h1 class="text-2xl font-headline font-extrabold text-on-primary-container tracking-tight">Доступ ограничен</h1>' +
      '<p class="text-secondary text-sm font-label mt-2 mb-6">Эта ссылка защищена паролем. Введите пароль для получения доступа.</p>' +
      '<form method="POST" action="/share/' + token + '/auth" class="space-y-4">' +
        '<div>' +
          '<input name="password" type="password" required class="w-full bg-surface-container-low border-none rounded-2xl px-5 py-3.5 text-on-surface font-body focus:ring-2 focus:ring-primary/20 transition-all placeholder:text-outline" placeholder="Пароль доступа"/>' +
        '</div>' +
        (errorMsg ? '<div style="font-size:12px;font-weight:bold;color:#ffb4ab;margin-top:8px">' + htmlEscape(errorMsg) + '</div>' : '') +
        '<button type="submit" class="w-full btn-primary bg-primary hover:bg-primary-container text-white rounded-2xl py-3.5 font-bold transition-all shadow-md mt-4" style="width:100%">Подтвердить</button>' +
      '</form>' +
    '</div>' +
  '</div>' +
  '</body></html>';
}
function shareNotFoundPage() {
  return '<!DOCTYPE html><html lang="ru"><head><title>Ссылка недействительна</title>' + HEAD + '</head>' +
  '<body class="bg-background font-body text-on-surface min-h-screen flex items-center justify-center">' +
  '<div class="text-center">' +
    '<span class="material-symbols-outlined text-7xl text-outline-variant">link_off</span>' +
    '<h1 class="text-2xl font-headline font-bold text-on-primary-container mt-4 mb-2">Ссылка недействительна</h1>' +
    '<p class="text-secondary font-body">Файл был удалён или ссылка отозвана.</p>' +
  '</div>' +
  '</body></html>';
}
// ─── HTML ────────────────────────────────────────────────────────
function sharePreviewPage(s, token, filename, sizeStr) {
  const isVideo = ['.mp4','.webm','.ogg','.mov','.mkv'].includes(path.extname(filename).toLowerCase());
  const isImg = ['.png','.jpg','.jpeg','.gif','.webp','.svg','.bmp'].includes(path.extname(filename).toLowerCase());
  const isAudio = ['.mp3','.wav','.ogg','.m4a','.aac'].includes(path.extname(filename).toLowerCase());
  const dlUrl = '/share/' + token + '?dl=1';
  let previewHtml = '';
  let plyrInit = '';
  if (isVideo) {
    previewHtml = `<video id="plyr-player" src="${dlUrl}" playsinline controls style="max-width:100%; max-height:70vh; border-radius:8px;"></video>`;
    plyrInit = `<script>
      (function(){
        try {
          const player = new Plyr('#plyr-player', {
            controls: ['play-large', 'play', 'progress', 'current-time', 'duration', 'mute', 'volume', 'captions', 'settings', 'pip', 'airplay', 'fullscreen'],
            settings: ['captions', 'quality', 'speed', 'loop']
          });
          const key = "plyr_time_" + encodeURIComponent("${filename}");
          player.on('ready', () => { const t = localStorage.getItem(key); if(t) player.currentTime = parseFloat(t); });
          player.on('timeupdate', () => { localStorage.setItem(key, player.currentTime); });
        } catch(e) { console.error("Plyr error:", e); }
      })();
    </script>`;
  } else if (isImg) {
    previewHtml = `<img src="${dlUrl}" style="max-width:100%; max-height:70vh; border-radius:8px; object-fit:contain; background:#1e1a25;">`;
  } else if (isAudio) {
    previewHtml = `<div style="padding:40px; background:#1e1a25; border-radius:8px; text-align:center; width:100%; box-sizing:border-box;"><span class="material-symbols-outlined" style="font-size:64px; color:#a078ff;">audio_file</span><br><br><audio id="plyr-player" src="${dlUrl}" controls playsinline></audio></div>`;
    plyrInit = `<script>
      (function(){
        try {
          const player = new Plyr('#plyr-player', {
            controls: ['play', 'progress', 'current-time', 'duration', 'mute', 'volume']
          });
          const key = "plyr_time_" + encodeURIComponent("${filename}");
          player.on('ready', () => { const t = localStorage.getItem(key); if(t) player.currentTime = parseFloat(t); });
          player.on('timeupdate', () => { localStorage.setItem(key, player.currentTime); });
        } catch(e) { console.error("Plyr audio error:", e); }
      })();
    </script>`;
  } else {
    previewHtml = `<div style="padding:60px 40px; background:#1e1a25; border-radius:8px; text-align:center; width:100%;"><span class="material-symbols-outlined" style="font-size:64px; color:#a078ff;">insert_drive_file</span><div style="margin-top:15px; color:#cbc3d7; font-size:16px;">Предпросмотр недоступен для этого формата файла</div></div>`;
  }
  
  const escFn = (str) => String(str).replace(/[&<>'"]/g, match => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[match]));
  return '<!DOCTYPE html><html lang="ru"><head><title>' + escFn(filename) + '</title>' + HEAD + '</head>' +
  '<body style="background:#15121b; color:#fff; font-family:sans-serif; margin:0; display:flex; flex-direction:column; align-items:center; min-height:100vh;">' +
  '<div style="max-width:1000px; width:100%; padding:20px 20px 40px; box-sizing:border-box;">' +
    '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; flex-wrap:wrap; gap:15px; padding-top:20px;">' +
      '<div style="flex:1; min-width:200px;">' +
        '<div style="font-size:24px; font-weight:bold; color:#fff; word-break:break-all;">' + escFn(filename) + '</div>' +
        '<div style="color:#958ea0; font-size:15px; margin-top:6px;">' + sizeStr + ' • ' + (s.downloads||0) + ' скачиваний</div>' +
      '</div>' +
      '<a href="' + dlUrl + '" style="background:#a078ff; color:#fff; padding:12px 24px; border-radius:8px; text-decoration:none; font-weight:bold; display:inline-flex; align-items:center; gap:8px; transition:background 0.2s;" onmouseover="this.style.background=\'#b291ff\'" onmouseout="this.style.background=\'#a078ff\'">Скачать файл <span class="material-symbols-outlined">download</span></a>' +
    '</div>' +
    '<div style="display:flex; justify-content:center; align-items:center; background:#1e1a25; border-radius:12px; padding:20px; box-shadow:0 10px 30px rgba(0,0,0,0.3);">' +
      previewHtml +
    '</div>' +
  '</div>' + plyrInit +
  '</body></html>';
}
const HEAD = `<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<link rel="icon" type="image/x-icon" href="/favicon.ico"/>
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png"/>
<link rel="icon" type="image/png" sizes="192x192" href="/favicon-192.png"/>
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png"/>
<link rel="manifest" href="/site.webmanifest"/>
<meta name="theme-color" content="#6b509a"/>
<script>if(localStorage.theme==='dark'||(!localStorage.theme&&matchMedia('(prefers-color-scheme:dark)').matches))document.documentElement.classList.add('dark')</script>
<script src="https://cdn.tailwindcss.com?plugins=forms"></script>
<script src="https://cdn.jsdelivr.net/npm/motion@10.18.0/dist/motion.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/plyr@3.7.8/dist/plyr.css" />
<script src="https://cdn.jsdelivr.net/npm/plyr@3.7.8/dist/plyr.polyfilled.js"></script>
<style>
:root { --plyr-color-main: #a078ff; }
.media-viewer .plyr { height: 100%; width: 100%; border-radius: 14px; box-shadow: 0 24px 90px rgba(0,0,0,.55); background: #000; }
.media-viewer .plyr video, .media-viewer .plyr audio { max-height: 100%; width: 100%; object-fit: contain; }
</style>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet"/>
<script>
if(window.tailwind)tailwind.config={darkMode:'class',theme:{extend:{colors:{"background":"rgb(var(--c-bg)/<alpha-value>)","surface":"rgb(var(--c-bg)/<alpha-value>)","surface-container-lowest":"rgb(var(--c-s0)/<alpha-value>)","surface-container-low":"rgb(var(--c-s1)/<alpha-value>)","surface-container":"rgb(var(--c-s2)/<alpha-value>)","surface-container-high":"rgb(var(--c-s3)/<alpha-value>)","surface-container-highest":"rgb(var(--c-s4)/<alpha-value>)","surface-variant":"rgb(var(--c-sv)/<alpha-value>)","primary":"rgb(var(--c-p)/<alpha-value>)","primary-container":"rgb(var(--c-pc)/<alpha-value>)","on-primary":"rgb(var(--c-op)/<alpha-value>)","on-primary-container":"rgb(var(--c-opc)/<alpha-value>)","primary-fixed-dim":"rgb(var(--c-pfd)/<alpha-value>)","secondary":"rgb(var(--c-sec)/<alpha-value>)","secondary-container":"rgb(var(--c-secc)/<alpha-value>)","on-secondary-container":"rgb(var(--c-osec)/<alpha-value>)","outline":"rgb(var(--c-out)/<alpha-value>)","outline-variant":"rgb(var(--c-outv)/<alpha-value>)","on-surface":"rgb(var(--c-os)/<alpha-value>)","on-surface-variant":"rgb(var(--c-osv)/<alpha-value>)","error":"rgb(var(--c-err)/<alpha-value>)","tertiary":"rgb(var(--c-ter)/<alpha-value>)"},fontFamily:{headline:["Plus Jakarta Sans"],body:["Manrope"],label:["Manrope"]},borderRadius:{"xl":"0.75rem","2xl":"1rem","3xl":"1.5rem","4xl":"2rem","full":"9999px"}}}}
</script>
<style>
:root{
  --c-bg:250 249 254;--c-s0:255 255 255;--c-s1:244 243 248;--c-s2:238 237 242;--c-s3:232 231 236;--c-s4:227 226 231;
  --c-sv:227 226 231;--c-p:107 80 154;--c-pc:160 131 209;--c-op:255 255 255;--c-opc:53 25 98;--c-pfd:213 187 255;
  --c-sec:99 91 110;--c-secc:234 222 245;--c-osec:105 97 116;--c-out:122 117 126;--c-outv:203 196 206;
  --c-os:26 28 31;--c-osv:73 69 78;--c-err:186 26 26;--c-ter:102 96 38;
}
html.dark{
  --c-bg:20 18 24;--c-s0:15 13 19;--c-s1:29 27 32;--c-s2:33 31 38;--c-s3:43 41 48;--c-s4:54 52 59;
  --c-sv:73 69 79;--c-p:208 188 255;--c-pc:79 55 139;--c-op:56 30 114;--c-opc:234 221 255;--c-pfd:208 188 255;
  --c-sec:204 194 220;--c-secc:74 68 88;--c-osec:204 194 220;--c-out:147 143 153;--c-outv:73 69 79;
  --c-os:230 225 229;--c-osv:202 196 207;--c-err:242 184 181;--c-ter:211 188 141;
}
html.dark aside{background:rgba(29,27,32,0.8)!important}
html.dark #vt-modal>div,html.dark #settings-modal>div{background:rgb(33,31,38)!important;border:1px solid rgb(73,69,79)}
html.dark #vt-modal .border-b,html.dark #settings-modal .border-b{border-color:rgb(73,69,79)!important}
html.dark .bg-white{background:rgb(33,31,38)!important}
html.dark [style*="background:#f4f3f8"]{background:rgb(43,41,48)!important;color:rgb(230,225,229)!important}
html.dark [style*="color:#1a1c1f"]{color:rgb(230,225,229)!important}
html.dark [style*="color:#635b6e"]{color:rgb(204,194,220)!important}
html.dark [style*="background:#fee2e2"]{background:rgba(242,184,181,0.15)!important}
body,aside,main,.file-card{transition:background-color 0.25s,border-color 0.25s,color 0.25s}
.glass{backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px)}
.material-symbols-outlined{font-variation-settings:'FILL' 0,'wght' 400,'GRAD' 0,'opsz' 24;vertical-align:middle}
::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:rgb(var(--c-outv));border-radius:9999px}
</style>`;
function loginPage(error) {
  return '<!DOCTYPE html><html lang="ru"><head><title>VPS Downloader</title>' + HEAD + '</head>' +
  '<body class="bg-background font-body text-on-surface min-h-screen flex items-center justify-center">' +
  '<div class="absolute inset-0 overflow-hidden pointer-events-none">' +
    '<div class="absolute -top-40 -right-40 w-96 h-96 bg-primary/5 rounded-full blur-3xl"></div>' +
    '<div class="absolute -bottom-40 -left-40 w-96 h-96 bg-primary-container/10 rounded-full blur-3xl"></div>' +
  '</div>' +
  '<div class="relative w-full max-w-sm mx-4">' +
    '<div class="bg-surface-container-lowest/80 glass rounded-4xl p-10 shadow-[0_32px_80px_rgba(107,80,154,0.08)]">' +
      '<div class="flex flex-col items-center mb-8">' +
        '<div class="w-14 h-14 rounded-3xl bg-gradient-to-tr from-primary to-primary-container flex items-center justify-center shadow-lg shadow-purple-200 mb-4">' +
          '<span class="material-symbols-outlined text-white text-2xl">cloud_download</span>' +
        '</div>' +
        '<h1 class="text-2xl font-headline font-extrabold text-on-primary-container tracking-tight">VPS Downloader</h1>' +
        '<p class="text-secondary text-sm font-label mt-1">Войдите в свой аккаунт</p>' +
      '</div>' +
      '<form method="POST" action="/login" class="space-y-4">' +
        '<div><label class="text-xs font-label text-secondary uppercase tracking-widest mb-2 block">Логин</label>' +
        '<input name="username" type="text" required autocomplete="username" class="w-full bg-surface-container-low border-none rounded-2xl px-5 py-3.5 text-on-surface font-body focus:ring-2 focus:ring-primary/20 transition-all placeholder:text-outline" placeholder="Ваш логин"/></div>' +
        '<div><label class="text-xs font-label text-secondary uppercase tracking-widest mb-2 block">Пароль</label>' +
        '<input name="password" type="password" required autocomplete="current-password" class="w-full bg-surface-container-low border-none rounded-2xl px-5 py-3.5 text-on-surface font-body focus:ring-2 focus:ring-primary/20 transition-all placeholder:text-outline" placeholder="••••••••"/></div>' +
        (error ? '<div class="bg-red-50 text-error text-sm font-label px-4 py-3 rounded-2xl">⚠ ' + error + '</div>' : '') +
        '<button type="submit" class="w-full mt-2 py-4 bg-gradient-to-r from-primary to-primary-container text-white rounded-full font-headline font-bold text-sm tracking-tight shadow-xl shadow-primary/20 hover:opacity-90 active:scale-95 transition-all">Войти</button>' +
      '</form>' +
    '</div>' +
  '</div>' +
  '</body></html>';
}
function mainPage(username) {
  const usersData = loadUsers();
  const label = usersData[username] ? usersData[username].label : username;
  const userIsAdmin = usersData[username] && usersData[username].isAdmin;
  const initial = label[0].toUpperCase();
  return '<!DOCTYPE html><html lang="ru"><head><title>VPS Downloader</title>' + HEAD + '</head>' +
  '<body class="bg-background font-body text-on-surface overflow-hidden">' +
  // Sidebar
  '<div id="sidebar-overlay" class="hidden fixed inset-0 z-40 md:hidden" style="background:rgba(0,0,0,0.4)" onclick="closeSidebar()"></div>' +
  '<aside id="sidebar" class="fixed left-0 top-0 h-screen w-60 z-50 bg-white/60 glass shadow-[4px_0_24px_rgba(107,80,154,0.06)] -translate-x-full md:translate-x-0 transition-transform duration-300">' +
  '<div class="flex flex-col p-5 h-full">' +
    '<div class="flex items-center gap-3 mb-8 mt-1">' +
      '<div class="w-9 h-9 rounded-xl bg-gradient-to-tr from-primary to-primary-container flex items-center justify-center shadow-md shadow-purple-200">' +
        '<span class="material-symbols-outlined text-white text-lg">cloud_download</span>' +
      '</div>' +
      '<div><h2 class="text-base font-headline font-extrabold text-on-primary-container leading-tight">Sipliy Folder VPS</h2>' +
      '<p class="text-[10px] text-secondary font-label tracking-widest uppercase">Remote Fetcher</p></div>' +
    '</div>' +
    '<nav class="flex-1 space-y-1">' +
      '<button onclick="showTab(\'downloads\')" id="nav-downloads" class="w-full flex items-center gap-3 bg-gradient-to-r from-primary to-primary-container text-white rounded-xl px-4 py-3 shadow-md shadow-purple-500/20 font-label text-sm">' +
        '<span class="material-symbols-outlined text-lg">download_for_offline</span> Загрузки' +
      '</button>' +
      '<button onclick="showTab(\'files\')" id="nav-files" class="w-full flex items-center gap-3 text-secondary px-4 py-3 hover:bg-secondary-container/30 rounded-xl transition-all font-label text-sm text-left">' +
        '<span class="material-symbols-outlined text-lg">folder_open</span> Готовые файлы' +
      '</button>' +
      '<button onclick="showTab(\'shares\')" id="nav-shares" class="w-full flex items-center gap-3 text-secondary px-4 py-3 hover:bg-secondary-container/30 rounded-xl transition-all font-label text-sm text-left">' +
        '<span class="material-symbols-outlined text-lg">link</span> Публичные ссылки' +
      '</button>' +
      '<button onclick="window.location=\'/cloud\'" class="w-full flex items-center gap-3 text-secondary px-4 py-3 hover:bg-secondary-container/30 rounded-xl transition-all font-label text-sm text-left">' +
        '<span class="material-symbols-outlined text-lg">cloud</span> Файловый менеджер' +
      '</button>' +
      '<button onclick="openSettings()" class="w-full flex items-center gap-3 text-secondary px-4 py-3 hover:bg-secondary-container/30 rounded-xl transition-all font-label text-sm text-left">' +
        '<span class="material-symbols-outlined text-lg">settings</span> Настройки' +
      '</button>' +
    '</nav>' +
    '<div class="mx-2 mt-2 flex items-center justify-between px-3 py-2.5 rounded-xl hover:bg-surface-container-low transition-colors gap-6">' +
      '<div class="flex items-center gap-3">' +
        '<span id="theme-icon" class="material-symbols-outlined text-lg text-secondary">dark_mode</span>' +
        '<span class="text-sm font-label text-secondary">Тёмная тема</span>' +
      '</div>' +
      '<button onclick="toggleDark()" id="dark-toggle" class="relative flex-shrink-0 w-11 h-6 rounded-full focus:outline-none" style="background:#cbc4ce;transition:background 0.25s">' +
        '<span id="dark-knob" class="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-sm" style="transition:transform 0.25s"></span>' +
      '</button>' +
    '</div>' +
    '<div class="disk-widget mx-2 mt-4 p-3 bg-surface-container-low rounded-2xl">' +
      '<p class="text-[10px] font-label text-secondary uppercase tracking-widest mb-2 flex items-center gap-1"><span class="material-symbols-outlined text-sm">storage</span> Диск</p>' +
      '<div class="w-full h-1.5 bg-surface-container-high rounded-full overflow-hidden mb-1.5">' +
        '<div id="disk-fill" class="h-full bg-gradient-to-r from-primary to-primary-container rounded-full transition-all duration-500" style="width:0%"></div>' +
      '</div>' +
      '<p id="disk-text" class="text-[11px] font-label text-secondary">Загрузка...</p>' +
    '</div>' +
    '<div class="mt-auto space-y-1 pt-4 border-t border-outline-variant/20">' +
      '<div class="flex items-center gap-3 px-4 py-3">' +
        '<div class="w-8 h-8 rounded-full bg-gradient-to-tr from-primary to-primary-container flex items-center justify-center text-white text-sm font-headline font-bold">' + initial + '</div>' +
        '<div class="flex-1 min-w-0"><p class="text-sm font-headline font-bold text-on-primary-container truncate">' + label + '</p>' +
        '<p class="text-xs text-secondary font-label">' + username + '</p></div>' +
      '</div>' +
      '<form method="POST" action="/logout">' +
        '<button type="submit" class="w-full flex items-center gap-3 text-error px-4 py-2.5 hover:bg-red-50 rounded-xl transition-all font-label text-sm">' +
          '<span class="material-symbols-outlined text-lg">logout</span> Выйти' +
        '</button>' +
      '</form>' +
    '</div>' +
  '</div></aside>' +
  // Main
  '<main class="ml-0 md:ml-60 h-screen overflow-y-auto bg-background px-4 py-6 md:p-8">' +
  '<div class="max-w-4xl mx-auto space-y-8 pb-16">' +
    // Mobile header
    '<div class="flex items-center gap-3 mb-4 md:hidden">' +
      '<button onclick="toggleSidebar()" class="p-2 rounded-xl bg-surface-container hover:bg-surface-container-high transition-colors">' +
        '<span class="material-symbols-outlined text-on-surface">menu</span>' +
      '</button>' +
      '<span class="text-base font-headline font-extrabold text-on-primary-container">Sipliy Folder VPS</span>' +
    '</div>' +
    // Hero
    '<section class="pt-2">' +
      '<h1 id="hero-title" data-text="Sipliy Folder VPS" class="text-4xl font-headline font-extrabold text-on-primary-container tracking-tight select-none cursor-default">Sipliy Folder VPS</h1>' +
      '<p class="text-secondary font-body text-base leading-relaxed mt-2 mb-8">Быстрая загрузка файлов на VPS по гигабитному каналу.</p>' +
      '<div class="relative group">' +
        '<div class="absolute -inset-1 bg-gradient-to-r from-primary to-primary-container rounded-[2rem] blur opacity-10 group-focus-within:opacity-25 transition duration-700"></div>' +
        '<div class="relative flex items-center p-2 bg-surface-container-lowest rounded-3xl shadow-[0_20px_50px_rgba(107,80,154,0.07)]">' +
          '<div class="px-4 text-primary"><span class="material-symbols-outlined">link</span></div>' +
          '<input id="url-input" type="text" class="flex-1 bg-transparent border-none focus:ring-0 text-on-surface font-body py-3.5 text-base placeholder:text-outline" placeholder="Вставьте ссылку (HTTP, торрент, магнет...)"/>' +
          '<button id="add-btn" onclick="addDownload()" style="font-family:\'Plus Jakarta Sans\',sans-serif;font-weight:700;white-space:nowrap" class="bg-gradient-to-r from-primary to-primary-container text-white px-7 py-3.5 rounded-2xl flex items-center gap-2 hover:opacity-90 active:scale-95 transition-all text-sm">' +
            '<span class="material-symbols-outlined" style="font-size:18px;vertical-align:middle">download</span> Скачать' +
          '</button>' +
        '</div>' +
      '</div>' +
      '<div id="rename-row" class="mt-2 flex items-center gap-2 opacity-0 transition-all duration-200" style="pointer-events:none">' +
        '<span class="material-symbols-outlined text-outline text-base px-1">drive_file_rename_outline</span>' +
        '<input id="filename-input" type="text" class="flex-1 bg-surface-container-low border border-outline-variant/30 focus:border-primary/40 rounded-xl px-4 py-2.5 text-on-surface font-body text-sm focus:ring-0 placeholder:text-outline outline-none transition-all" placeholder="Переименовать файл (необязательно)"/>' +
      '</div>' +
    '</section>' +
    // Downloads tab
    '<section id="tab-downloads">' +
      '<div class="flex items-center justify-between mb-5">' +
        '<h3 style="font-family:\'Plus Jakarta Sans\',sans-serif;font-weight:700;font-size:1.125rem;color:#1a1c1f;margin:0">Активные передачи</h3>' +
        '<button onclick="loadDownloads()" class="px-4 py-2 bg-surface-container-high rounded-full text-xs font-label text-on-secondary-container hover:bg-surface-variant transition-colors flex items-center gap-1">' +
          '<span class="material-symbols-outlined text-base">refresh</span> Обновить' +
        '</button>' +
      '</div>' +
      '<div id="downloads-list" class="space-y-4"><div class="text-center py-16 text-secondary font-label text-sm">Загрузка...</div></div>' +
    '</section>' +
    // Files tab
    '<section id="tab-files" class="hidden">' +
      '<div class="flex items-center justify-between mb-4">' +
        '<h3 style="font-family:\'Plus Jakarta Sans\',sans-serif;font-weight:700;font-size:1.125rem;color:#1a1c1f;margin:0">Готовые файлы</h3>' +
        '<button onclick="loadFiles()" class="px-4 py-2 bg-surface-container-high rounded-full text-xs font-label text-on-secondary-container hover:bg-surface-variant transition-colors flex items-center gap-1">' +
          '<span class="material-symbols-outlined text-base">refresh</span> Обновить' +
        '</button>' +
      '</div>' +
      // Upload zone
      '<div id="upload-zone" onclick="document.getElementById(\'file-input\').click()" class="relative mb-5 border-2 border-dashed border-outline-variant/50 hover:border-primary/50 rounded-3xl p-6 text-center cursor-pointer transition-all duration-200 group">' +
        '<input id="file-input" type="file" multiple class="hidden"/>' +
        '<div class="flex flex-col items-center gap-2 pointer-events-none">' +
          '<span class="material-symbols-outlined text-4xl text-outline-variant group-hover:text-primary transition-colors" style="font-variation-settings:\'FILL\' 0">cloud_upload</span>' +
          '<p class="text-sm font-headline font-bold text-secondary group-hover:text-on-surface transition-colors">Перетащи файлы или нажми для выбора</p>' +
          '<p class="text-xs font-label text-outline">Любые файлы · до 500 МБ</p>' +
        '</div>' +
      '</div>' +
      '<div id="upload-progress-list" class="space-y-2 mb-4"></div>' +
      '<div class="relative mb-4">' +
        '<span class="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-outline text-base pointer-events-none">search</span>' +
        '<input id="file-search" type="text" oninput="filterFiles()" class="w-full bg-surface-container-lowest border border-outline-variant/30 focus:border-primary/40 rounded-2xl pl-11 pr-4 py-3 text-on-surface font-body text-sm focus:ring-0 outline-none transition-all placeholder:text-outline" placeholder="Поиск по имени файла..."/>' +
      '</div>' +
      '<div id="files-list" class="space-y-3"><div class="text-center py-16 text-secondary font-label text-sm">Загрузка...</div></div>' +
    '</section>' +
    // Shares tab
    '<section id="tab-shares" class="hidden">' +
      '<div class="flex items-center justify-between mb-5">' +
        '<h3 style="font-family:\'Plus Jakarta Sans\',sans-serif;font-weight:700;font-size:1.125rem;color:#1a1c1f;margin:0">Публичные ссылки</h3>' +
        '<button onclick="loadShares()" class="px-4 py-2 bg-surface-container-high rounded-full text-xs font-label text-on-secondary-container hover:bg-surface-variant transition-colors flex items-center gap-1">' +
          '<span class="material-symbols-outlined text-base">refresh</span> Обновить' +
        '</button>' +
      '</div>' +
      '<div class="bg-surface-container-low/60 rounded-2xl px-5 py-3.5 mb-5 text-sm font-label text-secondary flex items-start gap-3">' +
        '<span class="material-symbols-outlined text-base mt-0.5 text-primary flex-shrink-0">info</span>' +
        '<span>Ссылки доступны без логина — можно делиться с кем угодно. Для отзыва нажми <b>×</b> рядом со ссылкой.</span>' +
      '</div>' +
      '<div id="shares-list" class="space-y-3"></div>' +
    '</section>' +
  '</div></main>' +
  // Toast
  '<div id="toast" class="fixed bottom-6 right-6 z-50 bg-surface-container-lowest glass shadow-xl rounded-2xl px-5 py-3.5 text-sm font-label text-on-surface opacity-0 translate-y-2 transition-all duration-300 pointer-events-none border border-outline-variant/20"></div>' +
  // VT Modal
  '<div id="vt-modal" class="hidden fixed inset-0 z-[100] flex items-center justify-center p-4" style="background:rgba(0,0,0,0.4);backdrop-filter:blur(4px)">' +
    '<div class="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden">' +
      '<div class="flex items-center justify-between px-6 pt-5 pb-4 border-b border-gray-100">' +
        '<div class="flex items-center gap-3">' +
          '<img src="https://www.virustotal.com/gui/images/favicon.png" style="width:20px;height:20px;border-radius:4px">' +
          '<div>' +
            '<p style="font-family:Plus Jakarta Sans,sans-serif;font-weight:700;font-size:0.95rem;color:#1a1c1f">VirusTotal Проверка</p>' +
            '<p id="vt-modal-name" style="font-size:0.72rem;color:#635b6e;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></p>' +
          '</div>' +
        '</div>' +
        '<button onclick="document.getElementById(\'vt-modal\').classList.add(\'hidden\')" class="p-2 hover:bg-gray-100 rounded-full text-gray-400 hover:text-gray-600 transition-colors">' +
          '<span class="material-symbols-outlined">close</span>' +
        '</button>' +
      '</div>' +
      '<div id="vt-modal-body"></div>' +
    '</div>' +
  '</div>' +
  // Settings Modal
  '<div id="settings-modal" class="hidden fixed inset-0 z-[100] flex items-center justify-center p-4" style="background:rgba(0,0,0,0.4);backdrop-filter:blur(4px)">' +
    '<div class="bg-white rounded-3xl shadow-2xl w-full max-w-md flex flex-col" style="max-height:82vh">' +
      '<div class="flex items-center justify-between px-6 pt-5 pb-4 border-b border-gray-100 flex-shrink-0">' +
        '<div class="flex items-center gap-3">' +
          '<span class="material-symbols-outlined" style="color:#6b509a">settings</span>' +
          '<p style="font-family:Plus Jakarta Sans,sans-serif;font-weight:700;font-size:0.95rem;color:#1a1c1f">Настройки</p>' +
        '</div>' +
        '<button onclick="document.getElementById(\'settings-modal\').classList.add(\'hidden\')" class="p-2 hover:bg-gray-100 rounded-full text-gray-400 hover:text-gray-600 transition-colors">' +
          '<span class="material-symbols-outlined">close</span>' +
        '</button>' +
      '</div>' +
      '<div class="p-6 space-y-5 overflow-y-auto">' +
        '<div>' +
          '<p class="font-headline font-bold text-sm text-on-surface mb-2">🗑 Автоудаление файлов</p>' +
          '<div class="flex gap-3 items-center">' +
            '<select id="retention-select" class="flex-1 bg-surface-container-low text-on-surface border border-outline-variant/30 rounded-xl px-4 py-2.5 text-sm outline-none">' +
              '<option value="1">1 день</option>' +
              '<option value="3">3 дня</option>' +
              '<option value="7">7 дней</option>' +
              '<option value="30">30 дней</option>' +
              '<option value="0">Никогда</option>' +
            '</select>' +
            '<button onclick="saveRetention()" class="px-4 py-2.5 rounded-xl text-sm font-bold text-white transition-all" style="background:#6b509a">Сохранить</button>' +
          '</div>' +
        '</div>' +
        '<div class="border-t border-outline-variant/30 pt-5">' +
          '<p class="font-headline font-bold text-sm text-on-surface mb-2">🔔 Уведомления о загрузке</p>' +
          '<div class="flex gap-3 items-center">' +
            '<p id="notif-status" class="flex-1 text-sm text-secondary"></p>' +
            '<button id="notif-btn" onclick="requestNotifPerm()" class="px-4 py-2.5 rounded-xl text-sm font-bold transition-all bg-surface-container-high text-secondary hover:bg-surface-variant">Разрешить</button>' +
          '</div>' +
        '</div>' +
        '<div class="border-t border-outline-variant/30 pt-5">' +
          '<p class="font-headline font-bold text-sm text-on-surface mb-2">🔑 Сменить пароль</p>' +
          '<div class="space-y-2">' +
            '<input id="pwd-current" type="password" placeholder="Текущий пароль" class="w-full bg-surface-container-low text-on-surface border border-outline-variant/30 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-primary"/>' +
            '<input id="pwd-new" type="password" placeholder="Новый пароль (мин. 6 символов)" class="w-full bg-surface-container-low text-on-surface border border-outline-variant/30 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-primary"/>' +
            '<button onclick="changePassword()" class="w-full px-4 py-2.5 rounded-xl text-sm font-bold text-white transition-all hover:opacity-90" style="background:#6b509a">Сменить пароль</button>' +
            '<p id="pwd-status" class="text-xs text-center min-h-[16px]"></p>' +
          '</div>' +
        '</div>' +
        (userIsAdmin ?
        '<div class="border-t border-outline-variant/30 pt-5">' +
          '<p class="font-headline font-bold text-sm text-on-surface mb-3">👥 Пользователи</p>' +
          '<div id="users-list" class="space-y-2 mb-3"></div>' +
          '<div class="bg-surface-container-low rounded-2xl p-3 space-y-2">' +
            '<p class="text-xs font-bold text-secondary uppercase tracking-wider mb-2">Добавить пользователя</p>' +
            '<input id="new-username" type="text" placeholder="Логин (a-z, 0-9, _)" class="w-full bg-white dark:bg-surface-container text-on-surface border border-outline-variant/30 rounded-xl px-3 py-2 text-sm outline-none focus:border-primary"/>' +
            '<input id="new-password" type="password" placeholder="Пароль" class="w-full bg-white dark:bg-surface-container text-on-surface border border-outline-variant/30 rounded-xl px-3 py-2 text-sm outline-none focus:border-primary"/>' +
            '<input id="new-label" type="text" placeholder="Отображаемое имя (необязательно)" class="w-full bg-white dark:bg-surface-container text-on-surface border border-outline-variant/30 rounded-xl px-3 py-2 text-sm outline-none focus:border-primary"/>' +
            '<button onclick="addUser()" class="w-full px-4 py-2 rounded-xl text-sm font-bold text-white transition-all hover:opacity-90" style="background:#6b509a">Создать пользователя</button>' +
            '<p id="users-status" class="text-xs text-center min-h-[16px]"></p>' +
          '</div>' +
        '</div>'
        : '') +
        '<div class="border-t border-outline-variant/30 pt-5">' +
          '<p class="font-headline font-bold text-sm text-on-surface mb-1">🧩 Токен для расширения</p>' +
          '<p class="text-xs text-secondary mb-3">Вставьте в настройки браузерного расширения</p>' +
          '<div id="token-display" class="bg-surface-container-low text-secondary rounded-xl px-4 py-3 text-xs font-mono break-all mb-3" style="line-height:1.6">Нажмите «Показать»</div>' +
          '<div class="flex gap-2">' +
            '<button onclick="loadMyToken()" class="flex-1 px-3 py-2 bg-surface-container-high text-secondary rounded-xl text-xs font-bold hover:bg-surface-variant transition-colors">Показать</button>' +
            '<button onclick="copyToken()" class="px-3 py-2 bg-surface-container-high text-secondary rounded-xl text-xs font-bold hover:bg-surface-variant transition-colors flex items-center gap-1"><span class="material-symbols-outlined" style="font-size:14px">content_copy</span></button>' +
            '<button onclick="resetMyToken()" class="px-3 py-2 rounded-xl text-xs font-bold transition-colors text-error hover:bg-error/10">Сбросить</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>' +
  '</div>' +
  // Notification permission banner
  '<div id="notif-banner" class="hidden fixed bottom-6 left-1/2 z-[200]" style="transform:translateX(-50%);width:calc(100% - 320px - 48px);max-width:600px">' +
    '<div class="bg-surface-container-lowest glass shadow-[0_16px_48px_rgba(107,80,154,0.14)] border border-outline-variant/20 rounded-2xl px-5 py-4 flex items-center gap-4">' +
      '<div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-primary to-primary-container flex items-center justify-center flex-shrink-0 shadow-md shadow-purple-200">' +
        '<span class="material-symbols-outlined text-white text-xl">notifications</span>' +
      '</div>' +
      '<div class="flex-1 min-w-0">' +
        '<p style="font-family:Plus Jakarta Sans,sans-serif;font-weight:700;font-size:0.875rem;color:#1a1c1f;margin-bottom:2px">Уведомления о загрузке</p>' +
        '<p class="text-xs font-label text-secondary">Узнавайте сразу, когда файл докачался — даже если вкладка свёрнута</p>' +
      '</div>' +
      '<div class="flex items-center gap-2 flex-shrink-0">' +
        '<button onclick="allowNotif()" class="px-4 py-2 rounded-xl text-sm font-bold text-white transition-all hover:opacity-90 active:scale-95" style="background:linear-gradient(135deg,#6b509a,#a083d1)">Разрешить</button>' +
        '<button onclick="dismissNotifBanner()" class="p-2 hover:bg-surface-container rounded-full text-outline hover:text-on-surface transition-colors">' +
          '<span class="material-symbols-outlined text-lg">close</span>' +
        '</button>' +
      '</div>' +
    '</div>' +
  '</div>' +
  '<script>\n' +
  'function toggleSidebar() {\n' +
  '  var s = document.getElementById("sidebar");\n' +
  '  var o = document.getElementById("sidebar-overlay");\n' +
  '  var isOpen = !s.classList.contains("-translate-x-full");\n' +
  '  if (isOpen) { s.classList.add("-translate-x-full"); o.classList.add("hidden"); }\n' +
  '  else { s.classList.remove("-translate-x-full"); o.classList.remove("hidden"); }\n' +
  '}\n' +
  'function closeSidebar() {\n' +
  '  document.getElementById("sidebar").classList.add("-translate-x-full");\n' +
  '  document.getElementById("sidebar-overlay").classList.add("hidden");\n' +
  '}\n' +
  '\n' +
  'function showTab(name) {\n' +
  '  ["downloads","files","shares"].forEach(function(t) {\n' +
  '    document.getElementById("tab-"+t).classList.toggle("hidden", t !== name);\n' +
  '    var nav = document.getElementById("nav-"+t);\n' +
  '    if (t === name) {\n' +
  '      nav.className = "w-full flex items-center gap-3 bg-gradient-to-r from-primary to-primary-container text-white rounded-xl px-4 py-3 shadow-md font-label text-sm";\n' +
  '    } else {\n' +
  '      nav.className = "w-full flex items-center gap-3 text-secondary px-4 py-3 hover:bg-[#eadef5]/30 rounded-xl transition-all font-label text-sm text-left";\n' +
  '    }\n' +
  '  });\n' +
  '  if (name === "files") loadFiles();\n' +
  '  if (name === "shares") loadShares();\n' +
  '  if (window.innerWidth < 768) closeSidebar();\n' +
  '  var panel = document.getElementById("tab-" + name);\n' +
  '  if (panel && window.Motion) Motion.animate(panel, { opacity: [0, 1], transform: ["translateY(10px)", "translateY(0)"] }, { duration: 0.22, easing: "ease-out" });\n' +
  '}\n' +
  '\n' +
  'function toast(msg) {\n' +
  '  var t = document.getElementById("toast");\n' +
  '  t.textContent = msg;\n' +
  '  t.style.opacity = "1"; t.style.transform = "translateY(0)";\n' +
  '  setTimeout(function() { t.style.opacity = "0"; t.style.transform = "translateY(8px)"; }, 3000);\n' +
  '}\n' +
  '\n' +
  'function fmt(b) {\n' +
  '  if (!b) return "—";\n' +
  '  var u=["B","KB","MB","GB"], i=0, v=b;\n' +
  '  while(v>=1024&&i<3){v/=1024;i++;} return v.toFixed(1)+" "+u[i];\n' +
  '}\n' +
  '\n' +
  'function fmtDate(d) {\n' +
  '  return new Date(d).toLocaleString("ru-RU",{day:"2-digit",month:"2-digit",year:"2-digit",hour:"2-digit",minute:"2-digit"});\n' +
  '}\n' +
  '\n' +
  'function fileIcon(name) {\n' +
  '  var e=(name||"").split(".").pop().toLowerCase();\n' +
  '  var m={exe:"laptop_windows",msi:"laptop_windows",zip:"folder_zip",rar:"folder_zip","7z":"folder_zip",tar:"folder_zip",gz:"folder_zip",mp4:"video_file",mkv:"video_file",avi:"video_file",mov:"video_file",webm:"video_file",mp3:"audio_file",flac:"audio_file",wav:"audio_file",pdf:"description",iso:"album",apk:"android",dmg:"laptop_mac",jpg:"image",jpeg:"image",png:"image",gif:"image"};\n' +
  '  return m[e] || "draft";\n' +
  '}\n' +
  '\n' +
  'var urlInput = document.getElementById("url-input");\n' +
  'var renameRow = document.getElementById("rename-row");\n' +
  'urlInput.addEventListener("focus", function() { renameRow.style.opacity="1"; renameRow.style.pointerEvents="auto"; });\n' +
  '\n' +
  'function addDownload() {\n' +
  '  var dlUrl = urlInput.value.trim();\n' +
  '  if (!dlUrl) { toast("⚠ Введите ссылку"); return; }\n' +
  '  var btn = document.getElementById("add-btn");\n' +
  '  btn.disabled = true;\n' +
  '  btn.innerHTML = \'<span class="material-symbols-outlined" style="font-size:18px;vertical-align:middle">hourglass_top</span> Добавляю...\';\n' +
  '  var body = new URLSearchParams();\n' +
  '  body.append("url", dlUrl);\n' +
  '  var fname = document.getElementById("filename-input").value.trim();\n' +
  '  if (fname) body.append("filename", fname);\n' +
  '  fetch("/api/add", { method: "POST", body: body })\n' +
  '    .then(function(r) { return r.json(); })\n' +
  '    .then(function(d) {\n' +
  '      if (d.error) throw new Error(d.error);\n' +
  '      urlInput.value = "";\n' +
  '      document.getElementById("filename-input").value = "";\n' +
  '      renameRow.style.opacity = "0"; renameRow.style.pointerEvents = "none";\n' +
  '      toast("✓ Загрузка добавлена!");\n' +
  '      loadDownloads();\n' +
  '    })\n' +
  '    .catch(function(e) { toast("✕ " + e.message); })\n' +
  '    .finally(function() {\n' +
  '      btn.disabled = false;\n' +
  '      btn.innerHTML = \'<span class="material-symbols-outlined" style="font-size:18px;vertical-align:middle">download</span> Скачать\';\n' +
  '    });\n' +
  '}\n' +
  '\n' +
  'urlInput.addEventListener("keydown", function(e) {\n' +
  '  if (e.key === "Enter") addDownload();\n' +
  '});\n' +
  '\n' +
  'function pauseDownload(gid) {\n' +
  '  fetch("/api/downloads/" + gid + "/pause", { method: "POST" })\n' +
  '    .then(function() { toast("⏸ Пауза"); loadDownloads(); });\n' +
  '}\n' +
  '\n' +
  'function resumeDownload(gid) {\n' +
  '  fetch("/api/downloads/" + gid + "/resume", { method: "POST" })\n' +
  '    .then(function() { toast("▶ Возобновлено"); loadDownloads(); });\n' +
  '}\n' +
  '\n' +
  'function removeDownload(gid) {\n' +
  '  fetch("/api/downloads/" + gid, { method: "DELETE" })\n' +
  '    .then(function() { toast("Удалено"); loadDownloads(); });\n' +
  '}\n' +
  '\n' +
  'var statusLabel = {active:"Скачивается",complete:"Готово",waiting:"Ожидание",error:"Ошибка",paused:"Пауза"};\n' +
  'var statusColor = {active:"text-primary bg-primary/10",complete:"text-green-600 bg-green-50",waiting:"text-yellow-600 bg-yellow-50",error:"text-red-600 bg-red-50",paused:"text-secondary bg-surface-container"};\n' +
  '\n' +
  'function loadDownloads() {\n' +
  '  fetch("/api/downloads").then(function(r){return r.json();}).then(function(data) {\n' +
  '    checkNotifications(data);\n' +
  '    var el = document.getElementById("downloads-list");\n' +
  '    if (!data.length) {\n' +
  '      el.innerHTML = \'<div class="text-center py-16"><span class="material-symbols-outlined text-5xl text-outline-variant">cloud_download</span><p class="mt-3 text-secondary font-label text-sm">Нет активных загрузок</p></div>\';\n' +
  '      return;\n' +
  '    }\n' +
  '    var html = "";\n' +
  '    data.forEach(function(d) {\n' +
  '      var barColor = d.status==="complete" ? "bg-green-400" : d.status==="error" ? "bg-red-400" : "bg-gradient-to-r from-primary to-primary-container";\n' +
  '      var accentColor = d.status==="complete" ? "bg-green-400" : d.status==="error" ? "bg-red-400" : "bg-gradient-to-b from-primary to-primary-container";\n' +
  '      var dlBtn = d.status==="complete"\n' +
  '        ? \'<a href="/download/\' + encodeURIComponent(d.name) + \'" download class="opacity-0 group-hover:opacity-100 px-3 py-2 bg-gradient-to-r from-primary to-primary-container text-white rounded-full text-xs font-bold flex items-center gap-1 hover:opacity-90 transition-all"><span class="material-symbols-outlined" style="font-size:14px">download</span> На ПК</a>\' +\n' +
  '          \'<button onclick="vtScan(this)" data-name="\' + encodeURIComponent(d.name) + \'" class="opacity-0 group-hover:opacity-100 px-3 py-2 bg-[#394ef5] text-white rounded-full text-xs font-bold flex items-center gap-1 hover:opacity-90 transition-all whitespace-nowrap"><img src="https://www.virustotal.com/gui/images/favicon.png" style="width:14px;height:14px;border-radius:2px"> VT Проверка</button>\'\n' +
  '        : "";\n' +
  '      var pauseBtn = "";\n' +
  '      if (d.status==="active"||d.status==="waiting") {\n' +
  '        pauseBtn = \'<button onclick="pauseDownload(\\\'\' + d.gid + \'\\\')" class="opacity-0 group-hover:opacity-100 p-2 hover:bg-yellow-50 text-outline hover:text-yellow-600 rounded-full transition-all" title="Пауза"><span class="material-symbols-outlined text-lg">pause</span></button>\';\n' +
  '      } else if (d.status==="paused") {\n' +
  '        pauseBtn = \'<button onclick="resumeDownload(\\\'\' + d.gid + \'\\\')" class="p-2 hover:bg-green-50 text-outline hover:text-green-600 rounded-full transition-all" title="Возобновить"><span class="material-symbols-outlined text-lg">play_arrow</span></button>\';\n' +
  '      }\n' +
  '      html += \'<div class="bg-surface-container-lowest rounded-3xl p-6 shadow-[0_8px_30px_rgba(107,80,154,0.05)] relative overflow-hidden group">\' +\n' +
  '        \'<div class="absolute top-0 left-0 w-1 h-full \' + accentColor + \'"></div>\' +\n' +
  '        \'<div class="flex justify-between items-start mb-4">\' +\n' +
  '          \'<div class="flex items-center gap-4">\' +\n' +
  '            \'<div class="w-11 h-11 bg-secondary-container/40 rounded-2xl flex items-center justify-center text-primary flex-shrink-0">\' +\n' +
  '              \'<span class="material-symbols-outlined">\' + fileIcon(d.name) + \'</span>\' +\n' +
  '            \'</div>\' +\n' +
  '            \'<div class="min-w-0">\' +\n' +
  '              \'<h4 class="font-headline font-bold text-on-primary-container text-sm leading-tight truncate max-w-xs" title="\' + d.name + \'">\' + d.name + \'</h4>\' +\n' +
  '              \'<div class="flex items-center gap-3 mt-1.5">\' +\n' +
  '                \'<span class="text-xs font-label px-2 py-0.5 rounded-full \' + (statusColor[d.status]||"text-secondary bg-surface-container") + \'">\' + (statusLabel[d.status]||d.status) + \'</span>\' +\n' +
  '                (d.size ? \'<span class="text-xs font-label text-secondary">\' + fmt(d.downloaded) + " / " + fmt(d.size) + \'</span>\' : "") +\n' +
  '                (d.speed ? \'<span class="text-xs font-label text-secondary">\' + fmt(d.speed) + "/s</span>" : "") +\n' +
  '              \'</div>\' +\n' +
  '            \'</div>\' +\n' +
  '          \'</div>\' +\n' +
  '          \'<div class="flex items-center gap-2">\' +\n' +
  '            (d.size ? \'<span class="font-headline font-bold text-primary text-lg">\' + d.progress + \'%</span>\' : "") +\n' +
  '            dlBtn +\n' +
  '            pauseBtn +\n' +
  '            \'<button onclick="removeDownload(\\\'\' + d.gid + \'\\\')" class="opacity-0 group-hover:opacity-100 p-2 hover:bg-red-50 text-outline hover:text-error rounded-full transition-all"><span class="material-symbols-outlined text-lg">close</span></button>\' +\n' +
  '          \'</div>\' +\n' +
  '        \'</div>\' +\n' +
  '        \'<div class="w-full h-1.5 bg-surface-container-low rounded-full overflow-hidden">\' +\n' +
  '          \'<div class="h-full rounded-full transition-all duration-500 \' + barColor + \'" style="width:\' + d.progress + \'%"></div>\' +\n' +
  '        \'</div>\' +\n' +
  '      \'</div>\';\n' +
  '    });\n' +
  '    var newCount = data.length;\n' +
  '    var doAnim = (el.getAttribute("data-dlcount") !== String(newCount));\n' +
  '    el.innerHTML = html;\n' +
  '    el.setAttribute("data-dlcount", newCount);\n' +
  '    if (doAnim) animateIn(el.children);\n' +
  '  });\n' +
  '}\n' +
  '\n' +
  'var allFiles = [];\n' +
  'var prevStatuses = {};\n' +
  '\n' +
  'function checkNotifications(data) {\n' +
  '  data.forEach(function(d) {\n' +
  '    if (prevStatuses[d.gid] && prevStatuses[d.gid] !== "complete" && d.status === "complete") {\n' +
  '      if ("Notification" in window && Notification.permission === "granted") {\n' +
  '        new Notification("✓ Загрузка завершена", { body: d.name });\n' +
  '      } else {\n' +
  '        toast("✓ Загружено: " + d.name);\n' +
  '      }\n' +
  '    }\n' +
  '    prevStatuses[d.gid] = d.status;\n' +
  '  });\n' +
  '}\n' +
  '\n' +
  '// ── Upload ──\n' +
  'var uploadZone = document.getElementById("upload-zone");\n' +
  'var fileInput  = document.getElementById("file-input");\n' +
  '\n' +
  'uploadZone.addEventListener("dragover", function(e) {\n' +
  '  e.preventDefault();\n' +
  '  uploadZone.style.borderColor = "rgb(var(--c-p))";\n' +
  '  uploadZone.style.background  = "rgb(var(--c-p)/0.05)";\n' +
  '});\n' +
  'uploadZone.addEventListener("dragleave", function() {\n' +
  '  uploadZone.style.borderColor = "";\n' +
  '  uploadZone.style.background  = "";\n' +
  '});\n' +
  'uploadZone.addEventListener("drop", function(e) {\n' +
  '  e.preventDefault();\n' +
  '  uploadZone.style.borderColor = "";\n' +
  '  uploadZone.style.background  = "";\n' +
  '  uploadFiles(e.dataTransfer.files);\n' +
  '});\n' +
  'fileInput.addEventListener("change", function(e) {\n' +
  '  uploadFiles(e.target.files);\n' +
  '  e.target.value = "";\n' +
  '});\n' +
  '\n' +
  'function uploadFiles(files) {\n' +
  '  var list = document.getElementById("upload-progress-list");\n' +
  '  Array.from(files).forEach(function(file) {\n' +
  '    var id = "up-" + Date.now() + "-" + Math.random().toString(36).slice(2);\n' +
  '    var card = document.createElement("div");\n' +
  '    card.id = id;\n' +
  '    card.className = "bg-surface-container-low rounded-2xl p-4";\n' +
  '    card.innerHTML =\n' +
  '      \'<div class="flex items-center justify-between mb-2">\' +\n' +
  '        \'<div class="flex items-center gap-2 min-w-0">\' +\n' +
  '          \'<span class="material-symbols-outlined text-primary text-base flex-shrink-0">upload_file</span>\' +\n' +
  '          \'<span class="text-xs font-label font-bold text-on-surface truncate max-w-xs">\' + file.name + \'</span>\' +\n' +
  '        \'</div>\' +\n' +
  '        \'<span id="\' + id + \'-pct" class="text-xs font-label text-secondary ml-3 flex-shrink-0">0%</span>\' +\n' +
  '      \'</div>\' +\n' +
  '      \'<div class="w-full h-1.5 bg-surface-container rounded-full overflow-hidden">\' +\n' +
  '        \'<div id="\' + id + \'-bar" class="h-full bg-gradient-to-r from-primary to-primary-container rounded-full" style="width:0%;transition:width 0.2s"></div>\' +\n' +
  '      \'</div>\';\n' +
  '    list.appendChild(card);\n' +
  '\n' +
  '    var xhr = new XMLHttpRequest();\n' +
  '    var fd  = new FormData();\n' +
  '    fd.append("files", file);\n' +
  '\n' +
  '    xhr.upload.addEventListener("progress", function(e) {\n' +
  '      if (!e.lengthComputable) return;\n' +
  '      var pct = Math.round(e.loaded / e.total * 100);\n' +
  '      document.getElementById(id + "-pct").textContent = pct + "%";\n' +
  '      document.getElementById(id + "-bar").style.width = pct + "%";\n' +
  '    });\n' +
  '    xhr.addEventListener("load", function() {\n' +
  '      if (xhr.status === 200) {\n' +
  '        document.getElementById(id + "-bar").className = "h-full bg-green-400 rounded-full";\n' +
  '        document.getElementById(id + "-pct").textContent = "✓";\n' +
  '        document.getElementById(id + "-pct").style.color = "#16a34a";\n' +
  '        setTimeout(function() { card.remove(); }, 1500);\n' +
  '        loadFiles();\n' +
  '      } else {\n' +
  '        document.getElementById(id + "-pct").textContent = "✕ Ошибка";\n' +
  '        document.getElementById(id + "-pct").style.color = "#dc2626";\n' +
  '      }\n' +
  '    });\n' +
  '    xhr.addEventListener("error", function() {\n' +
  '      document.getElementById(id + "-pct").textContent = "✕ Ошибка сети";\n' +
  '    });\n' +
  '    xhr.open("POST", "/api/upload");\n' +
  '    xhr.send(fd);\n' +
  '  });\n' +
  '}\n' +
  '\n' +
  'function filterFiles() {\n' +
  '  var q = document.getElementById("file-search").value.toLowerCase();\n' +
  '  renderFiles(q ? allFiles.filter(function(f){ return f.name.toLowerCase().indexOf(q) !== -1; }) : allFiles);\n' +
  '}\n' +
  '\n' +
  'function renderFiles(data) {\n' +
  '  var el = document.getElementById("files-list");\n' +
  '  if (!data.length) {\n' +
  '    el.innerHTML = \'<div class="text-center py-16"><span class="material-symbols-outlined text-5xl text-outline-variant">folder_open</span><p class="mt-3 text-secondary font-label text-sm">Файлы не найдены</p></div>\';\n' +
  '    return;\n' +
  '  }\n' +
  '  var html = "";\n' +
  '  data.forEach(function(f) {\n' +
  '    html += \'<div class="flex items-center justify-between p-4 bg-surface-container-lowest rounded-2xl hover:bg-surface-container-low transition-colors group">\' +\n' +
  '      \'<div class="flex items-center gap-4 min-w-0">\' +\n' +
  '        \'<span class="material-symbols-outlined text-secondary group-hover:text-primary transition-colors flex-shrink-0">\' + fileIcon(f.name) + \'</span>\' +\n' +
  '        \'<div class="min-w-0">\' +\n' +
  '          \'<p class="text-sm font-headline font-bold text-on-surface truncate max-w-sm" title="\' + f.name + \'">\' + f.name + \'</p>\' +\n' +
  '          \'<p class="text-xs text-secondary font-label mt-0.5">\' + fmt(f.size) + " · " + fmtDate(f.mtime) + \'</p>\' +\n' +
  '        \'</div>\' +\n' +
  '      \'</div>\' +\n' +
  '      \'<div class="flex items-center gap-2 flex-shrink-0 ml-4">\' +\n' +
  '        \'<a href="/download/\' + encodeURIComponent(f.name) + \'" download class="px-4 py-2 bg-gradient-to-r from-primary to-primary-container text-white rounded-full text-xs font-label font-bold hover:opacity-90 active:scale-95 transition-all flex items-center gap-1"><span class="material-symbols-outlined text-base">download</span> Скачать</a>\' +\n' +
  '        \'<button onclick="shareFile(this)" data-name="\' + encodeURIComponent(f.name) + \'" class="px-3 py-2 bg-surface-container-high text-secondary rounded-full text-xs font-bold flex items-center gap-1 hover:bg-secondary-container hover:text-on-secondary-container transition-all whitespace-nowrap"><span class="material-symbols-outlined text-sm">link</span> Ссылка</button>\' +\n' +
  '        (f.size <= 32*1024*1024 ? \'<button onclick="vtScan(this)" data-name="\' + encodeURIComponent(f.name) + \'" class="px-3 py-2 bg-[#394ef5] text-white rounded-full text-xs font-bold flex items-center gap-1 hover:opacity-90 transition-all whitespace-nowrap"><img src="https://www.virustotal.com/gui/images/favicon.png" style="width:14px;height:14px;border-radius:2px"> VT</button>\' : \'\') +\n' +
  '        \'<button onclick="deleteFile(this)" data-name="\' + encodeURIComponent(f.name) + \'" class="p-2 text-outline hover:text-error hover:bg-red-50 rounded-full transition-all"><span class="material-symbols-outlined text-lg">delete</span></button>\' +\n' +
  '      \'</div>\' +\n' +
  '    \'</div>\';\n' +
  '  });\n' +
  '  el.innerHTML = html;\n' +
  '  animateIn(el.children);\n' +
  '}\n' +
  '\n' +
  'function loadFiles() {\n' +
  '  fetch("/api/files").then(function(r){return r.json();}).then(function(data) {\n' +
  '    allFiles = data;\n' +
  '    var q = document.getElementById("file-search") ? document.getElementById("file-search").value : "";\n' +
  '    renderFiles(q ? allFiles.filter(function(f){ return f.name.toLowerCase().indexOf(q.toLowerCase()) !== -1; }) : allFiles);\n' +
  '  });\n' +
  '}\n' +
  '\n' +
  'function loadDisk() {\n' +
  '  fetch("/api/disk").then(function(r){return r.json();}).then(function(d) {\n' +
  '    if (d.error) return;\n' +
  '    document.getElementById("disk-fill").style.width = d.percent + "%";\n' +
  '    document.getElementById("disk-text").textContent = d.used + " / " + d.total + " — свободно " + d.avail;\n' +
  '  }).catch(function(){});\n' +
  '}\n' +
  '\n' +
  'function vtScan(btn) {\n' +
  '  var name = decodeURIComponent(btn.dataset.name);\n' +
  '  var modal = document.getElementById("vt-modal");\n' +
  '  var modalName = document.getElementById("vt-modal-name");\n' +
  '  var modalBody = document.getElementById("vt-modal-body");\n' +
  '  modalName.textContent = name;\n' +
  '  modalBody.innerHTML = \'<div class="flex flex-col items-center py-8 gap-3"><div class="w-8 h-8 border-2 border-[#394ef5] border-t-transparent rounded-full animate-spin"></div><p class="text-sm text-secondary">Проверяем в VirusTotal...</p></div>\';\n' +
  '  modal.classList.remove("hidden");\n' +
  '  fetch("/api/vt/" + encodeURIComponent(name))\n' +
  '    .then(function(r) { return r.json(); })\n' +
  '    .then(function(d) {\n' +
  '      if (d.error) { modalBody.innerHTML = \'<p class="text-error text-sm p-4">Ошибка: \' + d.error + \'</p>\'; return; }\n' +
  '      if (d.pending) { modalBody.innerHTML = \'<p class="text-secondary text-sm p-4 text-center">\' + d.message + \'</p>\'; return; }\n' +
  '      var s = d.stats;\n' +
  '      var malicious = s.malicious || 0;\n' +
  '      var suspicious = s.suspicious || 0;\n' +
  '      var bad = malicious + suspicious;\n' +
  '      var color = bad === 0 ? "#16a34a" : bad <= 3 ? "#d97706" : "#dc2626";\n' +
  '      var icon = bad === 0 ? "verified" : bad <= 3 ? "warning" : "dangerous";\n' +
  '      var label = bad === 0 ? "Файл чистый" : bad <= 3 ? "Подозрительный" : "Вредоносный";\n' +
  '      modalBody.innerHTML =\n' +
  '        \'<div class="flex flex-col items-center py-6 gap-4">\' +\n' +
  '          \'<span class="material-symbols-outlined text-6xl" style="color:\' + color + \';font-variation-settings:&quot;FILL&quot; 1">\' + icon + \'</span>\' +\n' +
  '          \'<p style="font-family:Plus Jakarta Sans,sans-serif;font-weight:800;font-size:1.5rem;color:\' + color + \'">\' + label + \'</p>\' +\n' +
  '          \'<div style="background:#f4f3f8;border-radius:1rem;padding:16px 32px;text-align:center">\' +\n' +
  '            \'<span style="font-size:2rem;font-weight:800;color:\' + color + \'">\' + bad + \'</span>\' +\n' +
  '            \'<span style="color:#635b6e;font-size:1rem"> / \' + d.total + \'</span>\' +\n' +
  '            \'<p style="color:#635b6e;font-size:0.75rem;margin-top:4px">антивирусов обнаружили угрозу</p>\' +\n' +
  '          \'</div>\' +\n' +
  '          \'<div style="display:flex;gap:12px;flex-wrap:wrap;justify-content:center">\' +\n' +
  '            \'<span style="background:#fee2e2;color:#dc2626;padding:4px 12px;border-radius:999px;font-size:0.75rem;font-weight:600">🦠 Вредоносных: \' + malicious + \'</span>\' +\n' +
  '            \'<span style="background:#fef3c7;color:#d97706;padding:4px 12px;border-radius:999px;font-size:0.75rem;font-weight:600">⚠️ Подозрительных: \' + suspicious + \'</span>\' +\n' +
  '            \'<span style="background:#dcfce7;color:#16a34a;padding:4px 12px;border-radius:999px;font-size:0.75rem;font-weight:600">✓ Чистых: \' + (s.undetected||0) + \'</span>\' +\n' +
  '          \'</div>\' +\n' +
  '          \'<a href="https://www.virustotal.com/gui/file/\' + d.hash + \'" target="_blank" style="color:#394ef5;font-size:0.8rem;text-decoration:underline">Открыть полный отчёт на VirusTotal ↗</a>\' +\n' +
  '          (d.cached ? \'<p style="color:#9ca3af;font-size:0.7rem">Результат из кэша VT</p>\' : \'\') +\n' +
  '        \'</div>\';\n' +
  '    })\n' +
  '    .catch(function(e) { modalBody.innerHTML = \'<p class="text-error text-sm p-4">Ошибка: \' + e.message + \'</p>\'; });\n' +
  '}\n' +
  '\n' +
  'function copyToClipboard(text) {\n' +
  '  if (navigator.clipboard && navigator.clipboard.writeText) {\n' +
  '    navigator.clipboard.writeText(text).then(function() {\n' +
  '      toast("🔗 Ссылка скопирована!");\n' +
  '    }).catch(function() { prompt("Скопируй ссылку:", text); });\n' +
  '  } else {\n' +
  '    var ta = document.createElement("textarea");\n' +
  '    ta.value = text;\n' +
  '    ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";\n' +
  '    document.body.appendChild(ta);\n' +
  '    ta.focus(); ta.select();\n' +
  '    try { document.execCommand("copy"); toast("🔗 Ссылка скопирована!"); }\n' +
  '    catch(e) { prompt("Скопируй ссылку:", text); }\n' +
  '    document.body.removeChild(ta);\n' +
  '  }\n' +
  '}\n' +
  '\n' +
  'function shareFile(btn) {\n' +
  '  var name = decodeURIComponent(btn.dataset.name);\n' +
  '  btn.disabled = true;\n' +
  '  var orig = btn.innerHTML;\n' +
  '  btn.innerHTML = \'<span class="material-symbols-outlined text-sm">hourglass_top</span>\';\n' +
  '  var body = new URLSearchParams();\n' +
  '  body.append("file", name);\n' +
  '  fetch("/api/share", { method: "POST", body: body })\n' +
  '    .then(function(r) { return r.json(); })\n' +
  '    .then(function(d) {\n' +
  '      if (d.error) { toast("✕ " + d.error); return; }\n' +
  '      var url = window.location.origin + "/share/" + d.token;\n' +
  '      copyToClipboard(url);\n' +
  '    })\n' +
  '    .catch(function(e) { toast("✕ " + e.message); })\n' +
  '    .finally(function() { btn.disabled = false; btn.innerHTML = orig; });\n' +
  '}\n' +
  '\n' +
  'function loadShares() {\n' +
  '  fetch("/api/shares").then(function(r) { return r.json(); }).then(function(data) {\n' +
  '    var el = document.getElementById("shares-list");\n' +
  '    if (!data.length) {\n' +
  '      el.innerHTML = \'<div class="text-center py-16"><span class="material-symbols-outlined text-5xl text-outline-variant">link_off</span><p class="mt-3 text-secondary font-label text-sm">Нет активных ссылок</p></div>\';\n' +
  '      return;\n' +
  '    }\n' +
  '    var html = "";\n' +
  '    data.forEach(function(s) {\n' +
  '      var url = window.location.origin + "/share/" + s.token;\n' +
  '      var shortToken = s.token.substring(0, 8) + "...";\n' +
  '      html += \'<div class="flex items-center justify-between p-4 bg-surface-container-lowest rounded-2xl group">\' +\n' +
  '        \'<div class="flex items-center gap-4 min-w-0">\' +\n' +
  '          \'<div class="w-10 h-10 rounded-xl bg-secondary-container/40 flex items-center justify-center flex-shrink-0">\' +\n' +
  '            \'<span class="material-symbols-outlined text-primary">link</span>\' +\n' +
  '          \'</div>\' +\n' +
  '          \'<div class="min-w-0">\' +\n' +
  '            \'<p class="text-sm font-headline font-bold text-on-surface truncate max-w-xs" title="\' + s.file + \'">\' + s.file + \'</p>\' +\n' +
  '            \'<p class="text-xs text-secondary font-label mt-0.5">\' + shortToken + \' · \' + fmtDate(s.created) + \'</p>\' +\n' +
  '          \'</div>\' +\n' +
  '        \'</div>\' +\n' +
  '        \'<div class="flex items-center gap-2 flex-shrink-0 ml-4">\' +\n' +
  '          \'<button onclick="showShareQr(this)" data-url="\' + encodeURIComponent(url) + \'" class="px-3 py-2 bg-surface-container-high text-secondary rounded-full text-xs font-bold flex items-center gap-1 hover:bg-secondary-container transition-all"><span class="material-symbols-outlined text-sm">qr_code_2</span> QR</button>\' +\n' +
  '          \'<button onclick="copyShareUrl(this)" data-url="\' + encodeURIComponent(url) + \'" class="px-3 py-2 bg-surface-container-high text-secondary rounded-full text-xs font-bold flex items-center gap-1 hover:bg-secondary-container transition-all"><span class="material-symbols-outlined text-sm">content_copy</span> Копировать</button>\' +\n' +
  '          \'<button onclick="revokeShare(this)" data-token="\' + s.token + \'" class="p-2 text-outline hover:text-error hover:bg-red-50 rounded-full transition-all" title="Отозвать ссылку"><span class="material-symbols-outlined text-lg">close</span></button>\' +\n' +
  '        \'</div>\' +\n' +
  '      \'</div>\';\n' +
  '    });\n' +
  '    el.innerHTML = html;\n' +
  '  });\n' +
  '}\n' +
  '\n' +
  'function copyShareUrl(btn) {\n' +
  '  copyToClipboard(decodeURIComponent(btn.dataset.url));\n' +
  '}\n' +
  '\n' +
  'function showShareQr(btn) {\n' +
  '  var url = decodeURIComponent(btn.dataset.url);\n' +
  '  window.open("/api/qr?data=" + encodeURIComponent(url), "_blank");\n' +
  '}\n' +
  '\n' +
  'function revokeShare(btn) {\n' +
  '  var token = btn.dataset.token;\n' +
  '  if (!confirm("Отозвать ссылку? Она перестанет работать.")) return;\n' +
  '  fetch("/api/share/" + token, { method: "DELETE" })\n' +
  '    .then(function() { toast("✓ Ссылка отозвана"); loadShares(); });\n' +
  '}\n' +
  '\n' +
  'function deleteFile(btn) {\n' +
  '  var name = decodeURIComponent(btn.dataset.name);\n' +
  '  if (!confirm("Удалить " + name + "?")) return;\n' +
  '  fetch("/api/files/" + encodeURIComponent(name), { method: "DELETE" })\n' +
  '    .then(function() { toast("🗑 Удалено"); loadFiles(); });\n' +
  '}\n' +
  '\n' +
  'function openSettings() {\n' +
  '  document.getElementById("settings-modal").classList.remove("hidden");\n' +
  '  loadRetention();\n' +
  '  updateNotifStatus();\n' +
  '  loadUsers();\n' +
  '}\n' +
  '\n' +
  'function updateNotifStatus() {\n' +
  '  var s = document.getElementById("notif-status");\n' +
  '  var b = document.getElementById("notif-btn");\n' +
  '  if (!("Notification" in window)) {\n' +
  '    s.textContent = "Не поддерживается браузером";\n' +
  '    b.style.display = "none"; return;\n' +
  '  }\n' +
  '  var p = Notification.permission;\n' +
  '  if (p === "granted") {\n' +
  '    s.textContent = "✓ Включены";\n' +
  '    s.style.color = "#16a34a";\n' +
  '    b.style.display = "none";\n' +
  '  } else if (p === "denied") {\n' +
  '    s.textContent = "✕ Заблокированы в браузере";\n' +
  '    s.style.color = "#dc2626";\n' +
  '    b.style.display = "none";\n' +
  '  } else {\n' +
  '    s.textContent = "Не разрешены";\n' +
  '    b.style.display = "";\n' +
  '  }\n' +
  '}\n' +
  '\n' +
  'function requestNotifPerm() {\n' +
  '  if (!("Notification" in window)) { toast("Браузер не поддерживает уведомления"); return; }\n' +
  '  Notification.requestPermission().then(function() { updateNotifStatus(); });\n' +
  '}\n' +
  '\n' +
  'function saveRetention() {\n' +
  '  var val = document.getElementById("retention-select").value;\n' +
  '  var body = new URLSearchParams();\n' +
  '  body.append("retention", val);\n' +
  '  fetch("/api/settings", { method: "POST", body: body })\n' +
  '    .then(function(r) { return r.json(); })\n' +
  '    .then(function() { toast("✓ Автоудаление сохранено"); });\n' +
  '}\n' +
  '\n' +
  'function loadRetention() {\n' +
  '  fetch("/api/settings").then(function(r) { return r.json(); }).then(function(d) {\n' +
  '    document.getElementById("retention-select").value = String(d.retention);\n' +
  '  });\n' +
  '}\n' +
  '\n' +
  'function loadMyToken() {\n' +
  '  fetch("/api/mytoken").then(function(r) { return r.json(); }).then(function(d) {\n' +
  '    document.getElementById("token-display").textContent = d.token;\n' +
  '  });\n' +
  '}\n' +
  '\n' +
  'function copyToken() {\n' +
  '  var t = document.getElementById("token-display").textContent;\n' +
  '  if (t === "Нажмите «Показать»") { toast("Сначала нажми «Показать»"); return; }\n' +
  '  copyToClipboard(t);\n' +
  '}\n' +
  '\n' +
  'function resetMyToken() {\n' +
  '  if (!confirm("Сбросить токен? Старый перестанет работать.")) return;\n' +
  '  fetch("/api/mytoken/reset", { method: "POST" })\n' +
  '    .then(function(r) { return r.json(); })\n' +
  '    .then(function(d) { document.getElementById("token-display").textContent = d.token; toast("✓ Токен обновлён"); });\n' +
  '}\n' +
  '\n' +
  'function showNotifBanner() {\n' +
  '  if (!("Notification" in window)) return;\n' +
  '  if (Notification.permission !== "default") return;\n' +
  '  if (localStorage.getItem("notif-dismissed")) return;\n' +
  '  setTimeout(function() {\n' +
  '    var b = document.getElementById("notif-banner");\n' +
  '    b.classList.remove("hidden");\n' +
  '    b.style.transition = "opacity 0.4s, transform 0.4s";\n' +
  '    b.style.opacity = "0"; b.style.transform = "translateX(-50%) translateY(16px)";\n' +
  '    requestAnimationFrame(function() {\n' +
  '      requestAnimationFrame(function() {\n' +
  '        b.style.opacity = "1"; b.style.transform = "translateX(-50%) translateY(0)";\n' +
  '      });\n' +
  '    });\n' +
  '  }, 2000);\n' +
  '}\n' +
  '\n' +
  'function dismissNotifBanner() {\n' +
  '  localStorage.setItem("notif-dismissed", "1");\n' +
  '  var b = document.getElementById("notif-banner");\n' +
  '  b.style.opacity = "0"; b.style.transform = "translateX(-50%) translateY(16px)";\n' +
  '  setTimeout(function() { b.classList.add("hidden"); }, 400);\n' +
  '}\n' +
  '\n' +
  'function allowNotif() {\n' +
  '  Notification.requestPermission().then(function(p) {\n' +
  '    dismissNotifBanner();\n' +
  '    if (p === "granted") toast("🔔 Уведомления включены!");\n' +
  '    updateNotifStatus();\n' +
  '  });\n' +
  '}\n' +
  '\n' +
  'function setToggleState(isDark) {\n' +
  '  var btn = document.getElementById("dark-toggle");\n' +
  '  var knob = document.getElementById("dark-knob");\n' +
  '  var icon = document.getElementById("theme-icon");\n' +
  '  if (!btn) return;\n' +
  '  btn.style.background = isDark ? "rgb(var(--c-p))" : "#cbc4ce";\n' +
  '  knob.style.transform = isDark ? "translateX(20px)" : "translateX(0)";\n' +
  '  icon.textContent = isDark ? "light_mode" : "dark_mode";\n' +
  '}\n' +
  '\n' +
  '// ── Смена пароля ──\n' +
  'function changePassword() {\n' +
  '  var cur = document.getElementById("pwd-current").value;\n' +
  '  var nw  = document.getElementById("pwd-new").value;\n' +
  '  var st  = document.getElementById("pwd-status");\n' +
  '  if (!cur || !nw) { st.textContent = "Заполните оба поля"; st.style.color = "#dc2626"; return; }\n' +
  '  var body = new URLSearchParams();\n' +
  '  body.append("currentPassword", cur);\n' +
  '  body.append("newPassword", nw);\n' +
  '  fetch("/api/change-password", { method: "POST", body: body })\n' +
  '    .then(function(r) { return r.json(); })\n' +
  '    .then(function(d) {\n' +
  '      if (d.error) { st.textContent = d.error; st.style.color = "#dc2626"; }\n' +
  '      else { st.textContent = "✓ Пароль изменён"; st.style.color = "#16a34a";\n' +
  '        document.getElementById("pwd-current").value = "";\n' +
  '        document.getElementById("pwd-new").value = ""; }\n' +
  '    }).catch(function() { st.textContent = "Ошибка"; st.style.color = "#dc2626"; });\n' +
  '}\n' +
  '\n' +
  '// ── Управление пользователями (admin) ──\n' +
  'function loadUsers() {\n' +
  '  var el = document.getElementById("users-list");\n' +
  '  if (!el) return;\n' +
  '  fetch("/api/users").then(function(r) { return r.json(); }).then(function(users) {\n' +
  '    el.innerHTML = users.map(function(u) {\n' +
  '      return \'<div class="flex items-center justify-between bg-white dark:bg-surface-container rounded-xl px-3 py-2">\' +\n' +
  '        \'<div>\' +\n' +
  '          \'<p class="text-sm font-bold text-on-surface">\' + u.label + (u.isAdmin ? \' <span class="text-xs text-primary font-normal">admin</span>\' : \'\') + \'</p>\' +\n' +
  '          \'<p class="text-xs text-secondary">@\' + u.username + \'</p>\' +\n' +
  '        \'</div>\' +\n' +
  '        (!u.isAdmin ? \'<button onclick="deleteUser(\\"\' + u.username + \'\\")" class="text-xs text-error hover:bg-red-50 px-2 py-1 rounded-lg transition-colors">Удалить</button>\' : \'\') +\n' +
  '      \'</div>\';\n' +
  '    }).join("");\n' +
  '  });\n' +
  '}\n' +
  '\n' +
  'function addUser() {\n' +
  '  var username = document.getElementById("new-username").value.trim();\n' +
  '  var password = document.getElementById("new-password").value;\n' +
  '  var label    = document.getElementById("new-label").value.trim();\n' +
  '  var st = document.getElementById("users-status");\n' +
  '  if (!username || !password) { st.textContent = "Логин и пароль обязательны"; st.style.color = "#dc2626"; return; }\n' +
  '  var body = new URLSearchParams();\n' +
  '  body.append("username", username);\n' +
  '  body.append("password", password);\n' +
  '  body.append("label", label || username);\n' +
  '  fetch("/api/users", { method: "POST", body: body })\n' +
  '    .then(function(r) { return r.json(); })\n' +
  '    .then(function(d) {\n' +
  '      if (d.error) { st.textContent = d.error; st.style.color = "#dc2626"; }\n' +
  '      else {\n' +
  '        st.textContent = "✓ Пользователь создан"; st.style.color = "#16a34a";\n' +
  '        document.getElementById("new-username").value = "";\n' +
  '        document.getElementById("new-password").value = "";\n' +
  '        document.getElementById("new-label").value = "";\n' +
  '        loadUsers();\n' +
  '      }\n' +
  '    }).catch(function() { st.textContent = "Ошибка"; st.style.color = "#dc2626"; });\n' +
  '}\n' +
  '\n' +
  'function deleteUser(username) {\n' +
  '  if (!confirm("Удалить пользователя @" + username + "? Его файлы останутся на сервере.")) return;\n' +
  '  fetch("/api/users/" + encodeURIComponent(username), { method: "DELETE" })\n' +
  '    .then(function(r) { return r.json(); })\n' +
  '    .then(function(d) {\n' +
  '      if (d.error) { toast("✕ " + d.error); }\n' +
  '      else { toast("✓ Пользователь СѓРґалён"); loadUsers(); }\n' +
  '    });\n' +
  '}\n' +
  '\n' +
  'function toggleDark() {\n' +
  '  var isDark = document.documentElement.classList.toggle("dark");\n' +
  '  localStorage.theme = isDark ? "dark" : "light";\n' +
  '  setToggleState(isDark);\n' +
  '}\n' +
  '\n' +
  'setToggleState(document.documentElement.classList.contains("dark"));\n' +
  '\n' +
  '// ── Animations ──\n' +
  'function animateIn(els, delay) {\n' +
  '  if (!window.Motion || !els || !els.length) return;\n' +
  '  Motion.animate(Array.from(els),\n' +
  '    { opacity: [0, 1], transform: ["translateY(12px)", "translateY(0)"] },\n' +
  '    { delay: Motion.stagger(delay || 0.045), duration: 0.26, easing: [0.25, 0.1, 0.25, 1] }\n' +
  '  );\n' +
  '}\n' +
  '\n' +
  '// sidebar nav buttons\n' +
  'if (window.Motion) {\n' +
  '  var navBtns = document.querySelectorAll("aside nav button");\n' +
  '  Motion.animate(Array.from(navBtns), { opacity: [0, 1], transform: ["translateX(-10px)", "translateX(0)"] }, { delay: Motion.stagger(0.07, { start: 0.15 }), duration: 0.3, easing: "ease-out" });\n' +
  '  // add-download card\n' +
  '  var addCard = document.querySelector("#tab-downloads > div:first-child");\n' +
  '  if (addCard) Motion.animate(addCard, { opacity: [0, 1], transform: ["translateY(-8px)", "translateY(0)"] }, { duration: 0.35, easing: "ease-out", delay: 0.1 });\n' +
  '  // hero title\n' +
  '  var heroEl2 = document.getElementById("hero-title");\n' +
  '  if (heroEl2) Motion.animate(heroEl2, { opacity: [0, 1] }, { duration: 0.5, easing: "ease-out" });\n' +
  '  // disk widget\n' +
  '  var diskWidget = document.querySelector(".disk-widget");\n' +
  '  if (diskWidget) Motion.animate(diskWidget, { opacity: [0, 1], transform: ["translateY(8px)", "translateY(0)"] }, { duration: 0.35, easing: "ease-out", delay: 0.35 });\n' +
  '}\n' +
  '\n' +
  'function initDecrypt(el) {\n' +
  '  var text = el.getAttribute("data-text") || el.textContent;\n' +
  '  var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";\n' +
  '  var frameMs = 40;\n' +
  '  var revealMs = 60;\n' +
  '  var timer = null;\n' +
  '  var running = false;\n' +
  '  function rand(c) { return c[Math.floor(Math.random() * c.length)]; }\n' +
  '  function play() {\n' +
  '    if (running) return;\n' +
  '    running = true;\n' +
  '    var revealed = 0;\n' +
  '    var total = text.length;\n' +
  '    clearInterval(timer);\n' +
  '    timer = setInterval(function() {\n' +
  '      var out = "";\n' +
  '      for (var i = 0; i < total; i++) {\n' +
  '        if (text[i] === " ") { out += " "; }\n' +
  '        else if (i < revealed) { out += text[i]; }\n' +
  '        else { out += rand(chars); }\n' +
  '      }\n' +
  '      el.textContent = out;\n' +
  '      revealed++;\n' +
  '      if (revealed > total) {\n' +
  '        clearInterval(timer);\n' +
  '        el.textContent = text;\n' +
  '        running = false;\n' +
  '      }\n' +
  '    }, revealMs);\n' +
  '  }\n' +
  '  setTimeout(play, 600);\n' +
  '}\n' +
  'var heroEl = document.getElementById("hero-title");\n' +
  'if (heroEl) initDecrypt(heroEl);\n' +
  '\n' +
  'showNotifBanner();\n' +
  'loadDownloads();\n' +
  'setInterval(loadDownloads, 3000);\n' +
  'loadDisk();\n' +
  'setInterval(loadDisk, 60000);\n' +
  '</script>' +
  '</body></html>';
}
function cloudPage(username) { // v3 — multiselect + upload progress + disk fix
  const cloudUsers = loadUsers();
  const profile = cloudUsers[username] || {};
  const profileLabel = profile.label || username;
  const profileInitial = (profileLabel || username || '?').trim().charAt(0).toUpperCase() || '?';
  const profileRole = profile.isAdmin ? 'Admin' : 'User';
  const safeUsername = htmlEscape(username);
  const safeProfileLabel = htmlEscape(profileLabel);
  const safeProfileInitial = htmlEscape(profileInitial);
  const safeProfileRole = htmlEscape(profileRole);
  return '<!DOCTYPE html>' +
  '<html lang="ru">' +
  '<head>' +
  '<meta charset="UTF-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>CloudSpace - ' + safeUsername + '</title>' +
  '<script src="https://cdn.tailwindcss.com"></script>' +
  '<script>' +
  'function hexToRgb(h){var r=parseInt(h.slice(1,3),16),g=parseInt(h.slice(3,5),16),b=parseInt(h.slice(5,7),16);return[r,g,b];}' +
  'function darkenHex(h,f){var c=hexToRgb(h);return"#"+c.map(function(x){return Math.max(0,Math.round(x*f)).toString(16).padStart(2,"0");}).join("");}' +
  'function lightenHex(h,f){var c=hexToRgb(h);return"#"+c.map(function(x){return Math.min(255,Math.round(x+(255-x)*f)).toString(16).padStart(2,"0");}).join("");}' +
  'function rgbToHsl(r,g,b){r/=255;g/=255;b/=255;var max=Math.max(r,g,b),min=Math.min(r,g,b);var h=0,s=0,l=(max+min)/2;if(max!==min){var d=max-min;s=l>0.5?d/(2-max-min):d/(max+min);switch(max){case r:h=((g-b)/d+(g<b?6:0))/6;break;case g:h=((b-r)/d+2)/6;break;case b:h=((r-g)/d+4)/6;break;}}return[Math.round(h*360),Math.round(s*100),Math.round(l*100)];}' +
  'function applyAccentColor(){' +
  '  var presets={"violet":"#a078ff","emerald":"#10b981","ruby":"#f43f5e","glacier":"#06b6d4"};' +
  '  var hex=localStorage.getItem("cloud-accent-hex")||presets[localStorage.getItem("cloud-accent")]||"#a078ff";' +
  '  var c=hexToRgb(hex);' +
  '  var hover=darkenHex(hex,0.78);' +
  '  var light=lightenHex(hex,0.6);' +
  '  var glow="rgba("+c[0]+","+c[1]+","+c[2]+",0.24)";' +
  '  var bg="rgba("+c[0]+","+c[1]+","+c[2]+",0.14)";' +
  '  var hsl=rgbToHsl(c[0],c[1],c[2]);' +
  '  var h=hsl[0];' +
  '  var isLight=localStorage.getItem("fm-theme")==="light";' +
  '  var bodyBg,surf,surfCont,surfHi;' +
  '  if(isLight){' +
  '    bodyBg="hsl("+h+",24%,96%)";' +
  '    surf="hsl("+h+",18%,100%)";' +
  '    surfCont="hsl("+h+",16%,94%)";' +
  '    surfHi="hsl("+h+",12%,87%)";' +
  '  } else {' +
  '    bodyBg="hsl("+h+",18%,7%)";' +
  '    surf="hsl("+h+",14%,11%)";' +
  '    surfCont="hsl("+h+",12%,14%)";' +
  '    surfHi="hsl("+h+",10%,18%)";' +
  '  }' +
  '  var root=document.documentElement;' +
  '  root.style.setProperty("--accent-color",hex);' +
  '  root.style.setProperty("--accent-glow",glow);' +
  '  root.style.setProperty("--accent-hover",hover);' +
  '  root.style.setProperty("--accent-bg",bg);' +
  '  root.style.setProperty("--accent-light",light);' +
  '  root.style.setProperty("--accent-gradient","linear-gradient(135deg,"+hex+","+hover+")");' +
  '  root.style.setProperty("--bg",bodyBg);' +
  '  root.style.setProperty("--surf",surf);' +
  '  root.style.setProperty("--surf-cont",surfCont);' +
  '  root.style.setProperty("--surf-hi",surfHi);' +
  '}' +
  'applyAccentColor();' +
  '</script>' +
  '<link rel="preconnect" href="https://fonts.googleapis.com">' +
  '<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@600;700;800&display=swap" rel="stylesheet">' +
  '<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet">' +
  '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/plyr@3.7.8/dist/plyr.css">' +
  '<script src="https://cdn.jsdelivr.net/npm/plyr@3.7.8/dist/plyr.polyfilled.js"></script>' +
  '<script>window.addEventListener("load",function(){var s=document.createElement("span");s.className="material-symbols-outlined";s.textContent="settings";s.style.cssText="position:absolute;visibility:hidden;font-size:24px;max-width:none;width:auto";document.body.appendChild(s);if(s.offsetWidth>36)document.documentElement.classList.add("no-symbol-font");s.remove();});</script>' +
  '<style>' +
  ':root{--m3-spring:cubic-bezier(0.34,1.56,0.64,1);--m3-std:cubic-bezier(0.2,0,0,1);--surf:#1b1b1f;--surf-cont:#1f1f23;--surf-hi:#2a292e;--on-surf:#e4e1e7;--on-surf-var:#c9c5cf;--outline:#84948b;--outline-var:#3b4a43;--accent-color:#a078ff;--accent-glow:rgba(160,120,255,0.28);--accent-hover:#7c3aed;--accent-bg:rgba(160,120,255,0.16);--accent-light:#d2bbff;--accent-gradient:linear-gradient(135deg,#a078ff,#7c3aed);--plyr-color-main:var(--accent-color);--font-display:"Plus Jakarta Sans",Manrope,sans-serif}' +
  '*{box-sizing:border-box}' +
  'body{font-family:Manrope,sans-serif;background:var(--bg,#12101a);color:var(--on-surf);letter-spacing:0;transition:background .5s var(--m3-std),color .3s;}' +
  '.material-symbols-outlined{font-family:"Material Symbols Outlined";font-variation-settings:"FILL" 0,"wght" 500,"GRAD" 0,"opsz" 24;line-height:1;vertical-align:middle;display:inline-flex;align-items:center;justify-content:center;max-width:1.25em;overflow:hidden;white-space:nowrap;text-transform:none}' +
  '.no-symbol-font .material-symbols-outlined{font-size:0!important;width:1.25em;min-width:1.25em;color:transparent!important}' +
  'body.flex{display:flex}' +
  '.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1 1 0%}.items-center{align-items:center}.justify-center{justify-content:center}.justify-between{justify-content:space-between}.gap-2{gap:8px}.gap-3{gap:12px}.sticky{position:sticky}.top-0{top:0}.h-screen{height:100vh}.overflow-y-auto{overflow-y:auto}.px-4{padding-left:16px;padding-right:16px}.py-6{padding-top:24px;padding-bottom:24px}.mb-6{margin-bottom:24px}' +
  '::-webkit-scrollbar{width:5px;height:5px}' +
  '::-webkit-scrollbar-track{background:transparent}' +
  '::-webkit-scrollbar-thumb{background:var(--outline-var);border-radius:9999px}' +
  '::-webkit-scrollbar-thumb:hover{background:var(--outline)}' +
  '.mobile-topbar,.mobile-bottom-nav{display:none}' +
  '.sidebar{background:var(--surf);width:272px;min-height:100vh;flex-shrink:0;border-radius:0 28px 28px 0;box-shadow:6px 0 40px rgba(0,0,0,.38),inset -1px 0 0 rgba(255,255,255,.05),inset 0 1px 0 rgba(255,255,255,.04)}' +
  '.card{background:var(--surf-cont);border:none;border-radius:24px;box-shadow:0 1px 0 rgba(255,255,255,.06) inset,0 2px 16px rgba(0,0,0,.28)}' +
  '.btn-primary{background:var(--accent-color);color:#fff;border-radius:9999px;padding:10px 24px;font-weight:700;font-size:14px;border:none;cursor:pointer;transition:transform var(--m3-spring) .35s,box-shadow .25s,opacity .2s;min-height:44px;letter-spacing:.01em}' +
  '.btn-primary:hover{opacity:.92;transform:translateY(-2px) scale(1.04);box-shadow:0 8px 28px var(--accent-glow)}' +
  '.btn-primary:active{transform:scale(.97);transition-duration:100ms}' +
  '.btn-ghost{background:var(--surf-hi);border:none;color:var(--on-surf);border-radius:9999px;padding:8px 18px;font-weight:700;font-size:13px;cursor:pointer;transition:background .2s,transform var(--m3-spring) .32s,box-shadow .2s;min-height:40px;display:inline-flex;align-items:center;justify-content:center;gap:6px}' +
  '.btn-ghost:hover{background:color-mix(in srgb,var(--accent-color) 18%,var(--surf-hi));transform:translateY(-1px);box-shadow:0 4px 14px rgba(0,0,0,.2)}' +
  '.btn-ghost:active{transform:scale(.97);transition-duration:100ms}' +
  '.nav-item{display:flex;align-items:center;gap:12px;padding:10px 16px;border-radius:9999px;cursor:pointer;color:var(--on-surf-var);font-size:13px;font-weight:600;transition:background .2s,color .2s,transform var(--m3-spring) .3s;text-decoration:none;margin:1px 8px}' +
  '.nav-item:hover{background:color-mix(in srgb,var(--accent-color) 12%,var(--surf-hi));color:var(--on-surf);transform:translateX(2px)}' +
  '.nav-item.active{background:color-mix(in srgb,var(--accent-color) 22%,var(--surf-hi));color:var(--on-surf);font-weight:700;box-shadow:0 0 0 1px color-mix(in srgb,var(--accent-color) 35%,transparent)}' +
  '.nav-item.active .material-symbols-outlined{font-variation-settings:"FILL" 1,"wght" 700,"GRAD" 0,"opsz" 24;color:var(--accent-light)}' +
  '.breadcrumb-sep{color:#494454;margin:0 6px}' +
  '.file-row{display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:16px;cursor:pointer;transition:background .2s,transform var(--m3-spring) .32s;border-bottom:1px solid color-mix(in srgb,var(--outline-var) 35%,transparent)}' +
  '.file-row:last-child{border-bottom:none}' +
  '.file-row:hover{background:var(--surf-hi);transform:translateX(3px)}' +
  '.file-row.selected{background:var(--accent-bg)}' +
  '.file-row.drag-over{background:var(--accent-bg)!important;outline:2px dashed var(--accent-color);outline-offset:-2px;border-radius:16px}' +
  '.file-row.dragging{opacity:.35}' +
  '.file-grid-item{background:var(--surf-cont);border:none;border-radius:28px;padding:20px 16px 16px;display:flex;flex-direction:column;align-items:center;gap:10px;cursor:pointer;transition:background .2s,transform var(--m3-spring) .32s,box-shadow .25s;text-align:center;animation:popIn .3s var(--m3-spring) both;box-shadow:0 1px 0 0 rgba(255,255,255,.06) inset,0 2px 12px rgba(0,0,0,.28)}' +
  '.file-grid-item:hover{background:var(--surf-hi);transform:translateY(-6px) scale(1.025);box-shadow:0 1px 0 0 rgba(255,255,255,.08) inset,0 20px 48px rgba(0,0,0,.38)}' +
  '.file-grid-item.selected{background:color-mix(in srgb,var(--accent-color) 14%,var(--surf-cont));box-shadow:0 0 0 2px var(--accent-color),0 12px 32px rgba(0,0,0,.32)}' +
  '.file-grid-item.drag-over{background:var(--accent-bg)!important;box-shadow:0 0 0 2px var(--accent-color)!important}' +
  '.file-grid-item.dragging{opacity:.35}' +
  '#drag-ghost-el{position:fixed;top:-600px;left:-600px;pointer-events:none;z-index:9999;overflow:visible}' +
  '.file-thumb{width:56px;height:56px;border-radius:18px;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--accent-color) 20%,var(--surf-hi));color:var(--accent-light);font-size:30px;overflow:hidden;flex:0 0 auto}' +
  '.file-thumb .material-symbols-outlined{font-size:28px;color:var(--accent-light)}' +
  '.file-thumb img{width:100%;height:100%;object-fit:cover}' +
  '.file-actions{display:flex;gap:4px;margin-top:auto;flex-wrap:wrap;justify-content:center;max-width:100%}' +
  '.file-actions .btn-ghost{padding:3px 7px!important;min-width:30px}' +
  '.item-menu-btn{width:40px;height:40px;min-height:40px;border-radius:9999px;padding:0;display:flex;align-items:center;justify-content:center;flex:0 0 auto}' +
  '.item-menu-btn .material-symbols-outlined{font-size:22px}' +
  '.drop-target{outline:2px dashed var(--accent-color)!important;outline-offset:-3px;background:var(--accent-bg)!important;color:var(--accent-light)!important}' +
  '.transfer-row{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid color-mix(in srgb,var(--outline-var) 35%,transparent)}' +
  '.transfer-row:last-child{border-bottom:none}' +
  '.transfer-card{display:flex;flex-direction:column;gap:8px;padding:12px 0;border-bottom:1px solid color-mix(in srgb,var(--outline-var) 35%,transparent)}' +
  '.transfer-card:last-child{border-bottom:none}' +
  '.transfer-top{display:flex;align-items:center;gap:10px}' +
  '.transfer-name{flex:1;min-width:0;font-size:13px;font-weight:700;color:var(--on-surf);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
  '.transfer-status{font-size:11px;font-weight:800;text-transform:uppercase;color:var(--accent-light);background:var(--accent-bg);border-radius:9999px;padding:3px 8px}' +
  '.transfer-meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 12px;font-size:12px;color:var(--outline)}' +
  '.transfer-controls{display:flex;gap:8px;flex-wrap:wrap}' +
  '.transfer-controls .btn-ghost{min-height:32px;padding:4px 10px;font-size:12px}' +
  '.progress-track{background:var(--surf-hi);border:none;border-radius:9999px;height:8px;overflow:hidden;flex:1}' +
  '.progress-fill{height:100%;border-radius:9999px;background:linear-gradient(90deg,var(--accent-color),var(--accent-hover));transition:width .4s var(--m3-std)}' +
  '.progress-fill.done{background:#10B981;box-shadow:0 0 10px rgba(16,185,129,.45)}' +
  '.transfer-card.is-error{border-color:#93000a;background:rgba(147,0,10,.07);padding-left:12px;padding-right:12px;border-radius:16px}' +
  '.transfer-card.is-active{border-color:var(--accent-hover);background:var(--accent-bg);padding-left:12px;padding-right:12px;border-radius:16px}' +
  '.transfer-section-title{font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.06em;color:var(--outline);margin:4px 0}' +
  '#transfers-card{display:none;position:fixed;right:24px;bottom:24px;z-index:520;width:min(560px,calc(100vw - 48px));max-height:min(62vh,620px);overflow:auto;margin:0!important;padding:20px!important;box-shadow:0 20px 80px rgba(0,0,0,.55);border-radius:28px!important}' +
  '#transfers-card.minimized{display:none!important}' +
  '#transfers-chip{display:none;position:fixed;right:24px;bottom:24px;z-index:521;align-items:center;gap:10px;background:var(--surf-cont);border:1px solid var(--accent-color);border-radius:9999px;padding:10px 18px;color:var(--on-surf);box-shadow:0 14px 50px rgba(0,0,0,.45);cursor:pointer}' +
  '#transfers-chip.active{display:flex}' +
  '.new-badge{display:inline-flex;align-items:center;margin-left:8px;border:1px solid rgba(16,185,129,.42);background:rgba(16,185,129,.14);color:#86efac;border-radius:9999px;padding:2px 7px;font-size:10px;font-weight:900;text-transform:uppercase}' +
  '.file-row.is-new,.file-grid-item.is-new{outline:2px solid rgba(16,185,129,.65)!important;outline-offset:-2px}' +
  '.history-row{display:grid;grid-template-columns:1fr 120px 90px 150px;gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid color-mix(in srgb,var(--outline-var) 35%,transparent);background:var(--surf-cont)}' +
  '.history-row:first-child{border-radius:16px 16px 0 0}' +
  '.history-row:last-child{border-bottom:none;border-radius:0 0 16px 16px}' +
  '.history-name{min-width:0;font-size:13px;font-weight:800;color:var(--on-surf);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
  '.history-meta{font-size:12px;color:var(--outline);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
  '.select-check{width:16px;height:16px;accent-color:var(--accent-color);cursor:pointer;flex:0 0 auto}' +
  '#selection-bar{display:none;align-items:center;gap:10px;padding:10px 24px;border-bottom:1px solid color-mix(in srgb,var(--outline-var) 45%,transparent);background:var(--surf);flex-shrink:0}' +
  '#upload-panel{display:none;position:fixed;right:24px;bottom:24px;z-index:350;width:min(420px,calc(100vw - 48px));background:var(--surf-cont);border:none;border-radius:24px;padding:20px;box-shadow:0 20px 70px rgba(0,0,0,.55);animation:slideUp .32s var(--m3-spring) both}' +
  '#toast{display:none;flex-direction:column;position:fixed;right:24px;bottom:24px;z-index:650;width:min(360px,calc(100vw - 48px));background:#18181c;border:1px solid rgba(255,255,255,0.08);border-radius:24px;padding:20px;box-shadow:0 12px 40px rgba(0,0,0,0.5);animation:slideUp .28s var(--m3-spring) both;box-sizing:border-box} #toast .toast-circle{transition:transform .2s cubic-bezier(.4,0,.2,1)} #toast .toast-circle:hover{transform:scale(1.08);background:color-mix(in srgb,var(--accent-color) 18%,#1b1b1e)!important}' +
  '#connection-pill{display:none;position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:700;align-items:center;gap:8px;background:rgba(28,25,33,.94);border:1px solid var(--accent-color);border-radius:9999px;padding:8px 14px;color:var(--on-surf);font-size:12px;font-weight:800;box-shadow:0 10px 34px rgba(0,0,0,.42);backdrop-filter:blur(18px)}' +
  '#connection-pill.offline{display:flex;border-color:#93000a;color:#ffdad6}' +
  '#connection-pill.checking{display:flex;border-color:var(--accent-color);color:var(--accent-light)}' +
  '#connection-pill .dot{width:8px;height:8px;border-radius:9999px;background:var(--accent-color);box-shadow:0 0 12px var(--accent-glow)}' +
  '#connection-pill.offline .dot{background:#ff5449;box-shadow:0 0 12px rgba(255,84,73,.8)}' +
  '.speed-result{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:12px}' +
  '.speed-metric{border:none;border-radius:16px;padding:12px;background:var(--surf);min-width:0}' +
  '.speed-metric b{display:block;color:var(--on-surf);font-size:18px;line-height:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
  '.speed-metric span{display:block;color:var(--outline);font-size:11px;margin-top:3px}' +
  '.preview-panel{display:none;width:380px;max-width:38vw;border-left:none;background:var(--surf-cont);flex-shrink:0;flex-direction:column;overflow:hidden;transform-origin:right center;position:relative!important;border-radius:24px 0 0 24px;box-shadow:-4px 0 32px rgba(0,0,0,.32),inset 1px 0 0 rgba(255,255,255,.05)}' +
  '.preview-resizer{position:absolute;left:0;top:0;bottom:0;width:6px;cursor:col-resize;z-index:100;background:transparent;transition:background 0.2s}' +
  '.preview-resizer:hover,.preview-resizer.dragging{background:var(--accent-color)!important}' +
  '.preview-panel.open{display:flex;animation:panelIn .28s var(--m3-std) both}' +
  '.preview-head{display:flex;align-items:center;gap:4px;padding:18px 16px 14px;flex-shrink:0}' +
  '.preview-body{overflow:auto;max-height:48%;flex-shrink:0;padding:0}' +
  '.preview-body.media-preview{display:flex;align-items:center;justify-content:center;background:#0c0a12;max-height:48%;flex-shrink:0;padding:0}' +
  '.preview-media{max-width:100%;max-height:100%;object-fit:contain;display:block}' +
  '.preview-info-section{flex:1;overflow-y:auto;display:flex;flex-direction:column;min-height:0}' +
  '.preview-meta-chip{background:var(--surf-hi);border-radius:12px;padding:10px 12px}' +
  '.preview-meta-label{font-size:10px;font-weight:600;color:var(--on-surf-var);text-transform:uppercase;letter-spacing:.8px;margin-bottom:4px}' +
  '.preview-action-btn{width:100%;justify-content:center;gap:8px;display:flex;align-items:center;font-size:14px;font-weight:600}' +
  '.mv-stage .plyr,.preview-media-wrap .plyr{width:auto;max-width:100%;border-radius:14px;background:#000;box-shadow:0 24px 90px rgba(0,0,0,.38);overflow:hidden}' +
  '.mv-stage .plyr{max-height:100%;height:auto}' +
  '.mv-stage .plyr video,.preview-media-wrap .plyr video{width:100%;height:100%;max-width:100%;max-height:72vh;object-fit:contain}' +
  '.mv-stage .plyr__video-wrapper,.preview-media-wrap .plyr__video-wrapper{background:#000!important;aspect-ratio:auto!important;padding-bottom:0!important;height:100%!important;display:flex;align-items:center;justify-content:center}' +
  '.preview-media-wrap .plyr audio{width:100%}' +
  '.plyr--full-ui input[type=range]{color:var(--accent-color)}' +
  '.preview-media-wrap{width:100%;min-height:260px;display:flex;align-items:center;justify-content:center}' +
  '.preview-media-wrap:fullscreen{background:#050506;padding:24px}' +
  '.preview-media-wrap:fullscreen .preview-media{max-width:100vw;max-height:100vh}' +
  '.doc-preview{font-size:13px;line-height:1.55;color:var(--on-surf);background:var(--surf);border:none;border-radius:16px;padding:16px;overflow:auto}' +
  '.doc-preview h1,.doc-preview h2,.doc-preview h3{margin:0 0 10px;color:var(--on-surf);line-height:1.2}' +
  '.doc-preview table,.archive-table{width:100%;border-collapse:collapse;font-size:12px}' +
  '.doc-preview td,.doc-preview th,.archive-table td,.archive-table th{border-bottom:1px solid var(--outline-var);padding:8px;text-align:left;vertical-align:top}' +
  '.doc-tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}' +
  '.doc-tab{border:none;background:var(--surf-hi);color:var(--on-surf);border-radius:9999px;padding:6px 14px;font-weight:700;font-size:12px;cursor:pointer;transition:background .2s,transform var(--m3-spring) .28s}' +
  '.doc-tab:hover{background:var(--accent-bg);transform:scale(1.05)}' +
  '.archive-path{max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--on-surf)}' +
  '.archive-dir{color:var(--accent-light);font-weight:800}' +
  '.media-viewer{position:fixed;inset:0;z-index:900;background:rgba(5,4,10,.97);display:none;flex-direction:column;color:#fff}' +
  '.media-viewer.open{display:flex;animation:viewerIn .25s var(--m3-std) both}' +
  '.mv-top{height:64px;display:flex;align-items:center;gap:10px;padding:0 18px;border-bottom:1px solid rgba(255,255,255,.07);background:rgba(18,16,26,.78);backdrop-filter:blur(22px)}' +
  '.mv-title{flex:1;min-width:0;font-size:15px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
  '.mv-icon{width:42px;height:42px;border-radius:9999px;border:none;background:rgba(255,255,255,.09);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:background .2s,transform var(--m3-spring) .3s}' +
  '.mv-icon:hover{background:var(--accent-bg);transform:scale(1.1)}' +
  '.mv-stage{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:18px;overflow:hidden;position:relative;background:radial-gradient(circle at 50% 50%,var(--accent-bg),transparent 42%)}' +
  '.mv-stage img,.mv-stage video{max-width:100%;max-height:100%;object-fit:contain;border-radius:14px;box-shadow:0 24px 90px rgba(0,0,0,.55)}' +
  '.mv-stage audio{width:min(720px,92vw)}' +
  '.mv-bottom{min-height:72px;display:flex;align-items:center;gap:12px;padding:12px 18px;border-top:1px solid rgba(255,255,255,.07);background:rgba(18,16,26,.78);backdrop-filter:blur(22px)}' +
  '.mv-seek{flex:1;accent-color:var(--accent-color)}' +
  '.mv-time{font-size:12px;color:var(--on-surf-var);min-width:96px;text-align:center}' +
  '.mv-range{width:100px;accent-color:var(--accent-color)}' +
  '.mv-center-play{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(.94);width:86px;height:86px;border-radius:9999px;border:none;background:rgba(18,16,26,.68);backdrop-filter:blur(20px);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 18px 60px rgba(0,0,0,.42);transition:opacity .18s,transform var(--m3-spring) .35s}' +
  '.mv-center-play.hidden{opacity:0;pointer-events:none;transform:translate(-50%,-50%) scale(.78)}' +
  '.mv-center-play .material-symbols-outlined{font-size:48px}' +
  '.mv-select{height:38px;border-radius:9999px;border:none;background:rgba(255,255,255,.1);color:#fff;padding:0 14px;font:700 12px Manrope,sans-serif;outline:none}' +
  '.mv-select option{background:#18161f;color:#fff}' +
  '.mv-hint{position:absolute;left:50%;top:18px;transform:translateX(-50%);background:rgba(18,16,26,.86);border:1px solid rgba(255,255,255,.12);border-radius:9999px;padding:7px 14px;color:var(--on-surf-var);font-size:12px;opacity:0;pointer-events:none;transition:opacity .18s}' +
  '.mv-hint.show{opacity:1}' +
  '#preview-info{flex:1;overflow-y:auto;display:flex;flex-direction:column;min-height:0;border-top:1px solid color-mix(in srgb,var(--outline-var) 30%,transparent);background:var(--surf-cont)}' +
  '.meta-row{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;padding:5px 0;border-bottom:1px solid color-mix(in srgb,var(--outline-var) 28%,transparent);font-size:12px}' +
  '.meta-row:last-child{border-bottom:none}' +
  '.meta-lbl{color:var(--outline);flex-shrink:0;padding-top:1px}' +
  '.meta-val{color:var(--on-surf-var);font-weight:500;text-align:right;word-break:break-all}' +
  '.dir-name{color:var(--accent-light)}' +
  '.file-name{color:var(--on-surf)}' +
  '.upload-file{font-size:12px;color:var(--on-surf-var);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
  '.modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:50;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)}' +
  '#modal-qr{z-index:120!important}' +
  '#modal-qr .modal{z-index:121}' +
  '.modal{background:var(--surf-cont);border:none;border-radius:28px;padding:28px;min-width:360px;max-width:90vw;animation:popIn .32s var(--m3-spring) both;box-shadow:0 1px 0 rgba(255,255,255,.06) inset,0 28px 80px rgba(0,0,0,.6)}' +
  '.modal h3,.modal h2{font-family:var(--font-display);font-weight:700;letter-spacing:-.01em}' +
  '.url-mode-card{border-radius:16px;padding:16px 14px;cursor:pointer;transition:background .18s var(--m3-std),border-color .18s var(--m3-std),box-shadow .18s var(--m3-std);background:var(--surf-hi);border:1.5px solid transparent;user-select:none}' +
  '.url-mode-card:hover{background:color-mix(in srgb,var(--on-surf) 6%,var(--surf-hi))}' +
  '.url-mode-card.selected{background:var(--accent-bg);border-color:var(--accent-color);box-shadow:0 0 0 1px color-mix(in srgb,var(--accent-color) 22%,transparent)}' +
  '.url-mode-card.selected:hover{background:color-mix(in srgb,var(--accent-color) 20%,var(--surf-hi))}' +
  '.url-dl-inp-wrap{position:relative;margin-bottom:20px}' +
  '.url-dl-inp-wrap .url-inp-icon{position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--on-surf-var);font-size:20px;pointer-events:none}' +
  '#url-dl-inp{width:100%;box-sizing:border-box;padding:13px 16px 13px 44px;border-radius:14px;background:var(--surf-hi);border:1.5px solid var(--outline-var);outline:none;font-size:14px;color:var(--on-surf);font-family:Manrope,sans-serif;transition:border-color .2s,box-shadow .2s}' +
  '#url-dl-inp:focus{border-color:var(--accent-color);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent-color) 18%,transparent)}' +
  '#url-name-inp{width:100%;box-sizing:border-box;padding:11px 16px;border-radius:14px;background:var(--surf-hi);border:1.5px solid var(--outline-var);outline:none;font-size:13px;color:var(--on-surf);font-family:Manrope,sans-serif;transition:border-color .2s,box-shadow .2s;margin-bottom:6px}' +
  '#url-name-inp:focus{border-color:var(--accent-color);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent-color) 18%,transparent)}' +
  '.inp{background:color-mix(in srgb,var(--accent-color) 8%,var(--surf));border:none;border-bottom:2px solid var(--outline-var);border-radius:10px 10px 0 0;color:var(--on-surf);padding:10px 14px;font-size:14px;width:100%;outline:none;font-family:Manrope,sans-serif;transition:border-color .2s,background .2s}' +
  '.inp:focus{border-bottom-color:var(--accent-color);background:color-mix(in srgb,var(--accent-color) 12%,var(--surf));box-shadow:0 2px 0 var(--accent-color)}' +
  '.disk-bar{background:var(--surf-hi);border-radius:9999px;height:10px;overflow:hidden}' +
  '.disk-fill{height:100%;border-radius:9999px;background:linear-gradient(90deg,var(--accent-color),color-mix(in srgb,var(--accent-color) 60%,var(--accent-hover)));transition:width .6s var(--m3-std)}' +
  'body.light{background:var(--bg,#f3eff8);color:#1c1a23}' +
  'body.light .sidebar{background:#fff;box-shadow:6px 0 40px rgba(0,0,0,.08),inset -1px 0 0 rgba(0,0,0,.05)}' +
  'body.light .sidebar [style*="color:#e4e1e6"]{color:#17151c!important}' +
  'body.light .sidebar [style*="color:#958ea0"]{color:#7b6f93!important}' +
  'body.light .sidebar [style*="color:#494454"]{color:#4a3b6e!important}' +
  'body.light .nav-item{color:#4a3b6e}' +
  'body.light .nav-item:hover{background:var(--accent-bg);color:var(--accent-hover)}' +
  'body.light .nav-item.active{background:var(--accent-bg);color:var(--accent-hover)}' +
  'body.light #main-area{background:#f6f3ff!important}' +
  'body.light #main-area>div:first-child{background:#fff!important;border-bottom-color:#e2d9f3!important}' +
  'body.light #main-area>div:nth-child(2){background:#f1ecfb!important;border-bottom-color:#d8cdec!important}' +
  'body.light #selection-bar{background:var(--accent-bg);border-bottom-color:#e2d9f3;color:#1c1a23}' +
  'body.light #file-scroll{background:var(--bg,#f3eff8)}' +
  'body.light .card{background:#fff;border:none;color:#1c1a23;box-shadow:0 2px 12px rgba(80,60,120,.1)}' +
  'body.light .transfer-row{border-bottom-color:#e2d9f3}' +
  'body.light .transfer-card{border-bottom-color:#e2d9f3}' +
  'body.light .transfer-name{color:#1c1a23}' +
  'body.light .transfer-status{background:var(--accent-bg);color:var(--accent-hover)}' +
  'body.light .transfer-meta{color:#7b6f93}' +
  'body.light .progress-track{background:#e2d9f3}' +
  'body.light #transfers-card,body.light #transfers-chip{background:#fff;border-color:var(--accent-color);color:#17151c}' +
  'body.light .history-row{background:#fff;border-bottom-color:#e2d9f3}' +
  'body.light .history-name{color:#1c1a23}' +
  'body.light .history-meta{color:#7b6f93}' +
  'body.light .file-row{background:#fff!important;border-bottom-color:#ede5ff;color:#1c1a23}' +
  'body.light .file-row:hover{background:var(--accent-bg)!important}' +
  'body.light .file-row.selected{background:var(--accent-bg)}' +
  'body.light .file-thumb{background:var(--accent-bg)}' +
  'body.light .dir-name{color:var(--accent-hover)}' +
  'body.light .file-name{color:#1c1a23}' +
  'body.light .file-grid-item{background:#fff!important;color:#1c1a23!important;box-shadow:0 2px 8px rgba(80,60,120,.1)!important}' +
  'body.light .file-grid-item:hover{background:var(--accent-bg)!important}' +
  'body.light .file-grid-item.selected{background:var(--accent-bg)!important;box-shadow:0 0 0 2px var(--accent-color),0 6px 20px rgba(80,60,120,.15)!important}' +
  'body.light .file-grid-item [style*="color:#e4e1e6"],body.light .file-row [style*="color:#e4e1e6"]{color:#1c1a23!important}' +
  'body.light .file-grid-item [style*="color:#d0bcff"],body.light .file-row [style*="color:#d0bcff"]{color:var(--accent-hover)!important}' +
  'body.light .modal{background:#fff;color:#1c1a23;box-shadow:0 24px 80px rgba(80,60,120,.2)}' +
  'body.light #upload-panel{background:#fff}' +
  'body.light #toast{background:#f5f3f7;border-color:rgba(0,0,0,0.08);color:#1c1a23} body.light #toast .toast-circle{background:#fff;border-color:rgba(0,0,0,0.06)}' +
  'body.light #connection-pill{background:rgba(255,255,255,.94);color:#1c1a23}' +
  'body.light .speed-metric{background:#faf8ff}' +
  'body.light .speed-metric b{color:#1c1a23}' +
  'body.light .preview-panel{background:#fff;border-left-color:#e2d9f3}' +
  'body.light .preview-head{border-bottom-color:#e2d9f3}' +
  'body.light #preview-title{color:#1c1a23}' +
  'body.light #preview-info{background:#fff;border-top-color:#e2d9f3}' +
  'body.light .preview-panel{background:#fff;box-shadow:-4px 0 32px rgba(0,0,0,.08),inset 1px 0 0 rgba(0,0,0,.05)}' +
  'body.light .doc-preview{background:#fff;color:#1c1a23}' +
  'body.light .doc-preview h1,body.light .doc-preview h2,body.light .doc-preview h3{color:#1c1a23}' +
  'body.light .doc-preview td,body.light .doc-preview th,body.light .archive-table td,body.light .archive-table th{border-bottom-color:#e2d9f3}' +
  'body.light .doc-tab{background:#ede7f6;color:#1c1a23}' +
  'body.light .archive-path{color:#1c1a23}' +
  'body.light .meta-row{border-bottom-color:#e8e0f4}' +
  'body.light .meta-lbl{color:#9b91b4}' +
  'body.light .meta-val{color:#1c1a23}' +
  'body.light .preview-body{color:#1c1a23}' +
  'body.light .breadcrumb-sep{color:#c9bfe0}' +
  'body.light .disk-bar{background:#e2d9f3}' +
  'body.light #disk-label{color:#4a3b6e}' +
  'body.light .inp{background:#f0ebfa;color:#1c1a23;border-bottom-color:#c9bfe0}' +
  'body.light .inp:focus{border-bottom-color:var(--accent-color);background:#eae4f6;box-shadow:0 2px 0 var(--accent-color)}' +
  'body.light .btn-ghost{color:#4a3b6e;background:#ede7f6}' +
  'body.light .btn-ghost:hover{background:var(--accent-bg);color:var(--accent-hover)}' +
  'body.light .btn-primary{background:var(--accent-color)!important;color:#fff!important}' +
  'body.light .mobile-actions button{background:#ede7f6!important;border:none!important;color:#4a3b6e!important}' +
  'body.light .mobile-topbar,body.light .mobile-bottom-nav{background:rgba(255,255,255,.88)!important;border-color:#e2d9f3!important}' +
  'body.light .mobile-brand{color:#1c1a23!important;text-shadow:none!important}' +
  'body.light .mobile-avatar{background:var(--accent-bg)!important;color:var(--accent-hover)!important}' +
  'body.light #ctx-menu{background:#fff!important;border-color:#d8cdec!important;box-shadow:0 12px 40px rgba(50,34,80,.18)!important}' +
  'body.light .ctx-item{color:#2d2440!important}' +
  'body.light .ctx-item:hover{background:var(--accent-bg)!important;color:var(--accent-hover)!important}' +
  'body.light .ctx-sep{background:#e8e0f4!important}' +
  'body.light #file-area{color:#1c1a23}' +
  /* context menu */
  '#ctx-menu{position:fixed;z-index:500;background:var(--surf-cont);border:none;border-radius:18px;padding:6px;min-width:200px;box-shadow:0 16px 60px rgba(0,0,0,.65);display:none;transform-origin:top left}' +
  '#ctx-menu.open{animation:menuIn .2s var(--m3-spring) both}' +
  '.ctx-item{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:12px;cursor:pointer;font-size:13px;font-weight:600;color:var(--on-surf);transition:background .15s,transform var(--m3-spring) .25s}' +
  '.ctx-item:hover{background:var(--accent-bg);color:var(--accent-light);transform:translateX(2px)}' +
  '.ctx-item.danger{color:#ffb4ab}' +
  '.ctx-item.danger:hover{background:rgba(255,180,171,.1);color:#ff8a80}' +
  '.ctx-sep{height:1px;background:var(--outline-var);margin:4px 8px;opacity:.4}' +
  /* drop zone overlay */
  '#drop-zone{position:fixed;inset:0;z-index:300;pointer-events:none;display:none;align-items:center;justify-content:center;flex-direction:column;gap:12px;background:rgba(109,59,215,.1);border:3px dashed var(--accent-color);border-radius:0}' +
  '#drop-zone.active{display:flex}' +
  /* Custom features classes */
  '.filter-pill{background:var(--surf-hi);border:none;color:var(--on-surf-var);border-radius:9999px;padding:7px 16px;font-size:12px;font-weight:700;cursor:pointer;transition:background .2s,color .2s,transform var(--m3-spring) .3s}' +
  '.filter-pill:hover{background:color-mix(in srgb,var(--accent-color) 16%,var(--surf-hi));color:var(--on-surf);transform:scale(1.04)}' +
  '.filter-pill.active{background:var(--accent-color);color:#fff;box-shadow:0 4px 14px var(--accent-glow);transform:scale(1.06)}' +
  'body.light .filter-pill{background:#ede7f6;color:#4a3b6e}' +
  'body.light .filter-pill:hover{background:var(--accent-bg);color:var(--accent-hover)}' +
  'body.light .filter-pill.active{background:var(--accent-color);color:#fff}' +
  '.settings-hero{position:relative;overflow:hidden;border:none;border-radius:28px;padding:28px;background:radial-gradient(circle at 14% -20%,var(--accent-bg),transparent 42%),linear-gradient(135deg,#231e30,#18151f 64%,#111019);box-shadow:0 24px 80px rgba(0,0,0,.32);margin-bottom:20px}' +
  '.settings-hero-icon{width:56px;height:56px;border-radius:20px;background:var(--accent-gradient);display:flex;align-items:center;justify-content:center;color:#fff;box-shadow:0 14px 40px var(--accent-glow)}' +
  '.settings-card-title{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:900;margin-bottom:14px;color:var(--on-surf)}' +
  '.settings-card-title .material-symbols-outlined{color:var(--accent-light)}' +
  '.settings-subtle{font-size:12px;color:var(--outline);line-height:1.5}' +
  '.settings-grid{display:grid;grid-template-columns:1fr;gap:18px}' +
  '@media(min-width:1024px){.settings-grid{grid-template-columns:1fr 1fr!important}}' +
  '.color-swatch{width:34px;height:34px;border-radius:50%;border:3px solid transparent;cursor:pointer;flex-shrink:0;transition:transform var(--m3-spring) .3s,border-color .15s,box-shadow .15s;box-shadow:0 2px 8px rgba(0,0,0,.3)}' +
  '.color-swatch:hover{transform:scale(1.22);box-shadow:0 6px 20px rgba(0,0,0,.5)}' +
  '.color-swatch.active{border-color:#fff!important;transform:scale(1.18);box-shadow:0 0 0 3px rgba(255,255,255,.28)}' +
  '#accent-color-input{width:46px;height:38px;border:none;border-radius:10px;cursor:pointer;padding:0;background:none;flex-shrink:0}' +
  '#accent-color-input::-webkit-color-swatch-wrapper{padding:0;border-radius:8px}' +
  '#accent-color-input::-webkit-color-swatch{border:none;border-radius:8px}' +
  '.theme-card{display:flex;align-items:center;gap:12px;padding:14px 18px;border-radius:18px;background:var(--surf);border:none;cursor:pointer;transition:background .2s,box-shadow .25s,transform var(--m3-spring) .32s}' +
  '.theme-card:hover{background:var(--surf-hi);transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,.22)}' +
  '.theme-card.active{background:var(--accent-bg);box-shadow:0 0 0 2px var(--accent-color),0 8px 28px rgba(0,0,0,.22)}' +
  'body.light .theme-card{background:#faf8ff}' +
  'body.light .theme-card:hover{background:var(--accent-bg)}' +
  'body.light .theme-card.active{background:var(--accent-bg);box-shadow:0 0 0 2px var(--accent-color)}' +
  '.theme-card-dot{width:22px;height:22px;border-radius:9999px;flex:0 0 auto}' +
  'body.light .settings-hero{background:radial-gradient(circle at 14% -20%,var(--accent-bg),transparent 42%),linear-gradient(135deg,#fff,#f7f2ff);box-shadow:0 22px 60px rgba(62,45,92,.12)}' +
  'body.light .settings-hero [style*="color:#fff"],body.light .theme-card [style*="color:#e4e1e6"]{color:#1c1a23!important}' +
  'body.light .settings-card-title{color:#1c1a23}' +
  'body.light .settings-subtle{color:#7b6f93}' +
  '.code-hl-kw{color:#ff79c6;font-weight:bold}' +
  '.code-hl-str{color:#f1fa8c}' +
  '.code-hl-cmt{color:#6272a4;font-style:italic}' +
  '.code-hl-num{color:#bd93f9}' +
  '.code-hl-fn{color:#50fa7b}' +
  '.code-hl-tag{color:#8be9fd}' +
  '.code-hl-attr{color:#ffb86c}' +
  '@keyframes popIn{from{opacity:0;transform:scale(.86) translateY(10px)}to{opacity:1;transform:scale(1) translateY(0)}}' +
  '@keyframes slideUp{from{opacity:0;transform:translateY(16px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}' +
  '@keyframes panelIn{from{opacity:0;transform:translateX(24px) scale(.97)}to{opacity:1;transform:translateX(0) scale(1)}}' +
  '@keyframes menuIn{from{opacity:0;transform:translateY(-8px) scale(.88)}to{opacity:1;transform:translateY(0) scale(1)}}' +
  '@keyframes viewerIn{from{opacity:0;transform:scale(.98)}to{opacity:1;transform:scale(1)}}' +
  '@media (max-width:768px){' +
  'body{display:block!important;min-height:100dvh;overflow-x:hidden;padding:0 0 96px;background:var(--bg,#12101a)}' +
  '.mobile-topbar{display:flex;position:sticky;top:0;z-index:60;height:64px;align-items:center;justify-content:space-between;padding:0 20px;background:rgba(18,16,26,.9);backdrop-filter:blur(22px);-webkit-backdrop-filter:blur(22px);border-bottom:1px solid rgba(60,55,70,.5)}' +
  '.mobile-brand{font-size:28px;line-height:34px;font-weight:800;color:#fff;letter-spacing:0;text-shadow:0 2px 12px rgba(0,0,0,.45)}' +
  '.mobile-avatar{width:36px;height:36px;border-radius:9999px;background:var(--surf-hi);border:none;display:flex;align-items:center;justify-content:center;color:var(--accent-light)}' +
  '.mobile-icon-btn{width:44px;height:44px;border:0;border-radius:9999px;background:transparent;color:var(--accent-color);display:flex;align-items:center;justify-content:center}' +
  '.mobile-icon-btn .material-symbols-outlined{font-size:32px}' +
  '.sidebar{display:none!important}' +
  '#main-area{min-height:calc(100dvh - 64px);display:block!important}' +
  '.desktop-toolbar{display:none!important}' +
  '.mobile-toolbar{display:flex!important;padding:44px 20px 14px!important;gap:14px!important;align-items:center!important;border-bottom:0!important;background:transparent!important;flex-wrap:wrap!important;height:auto!important}' +
  '.mobile-toolbar>button:not([data-action="upload-btn"]):not([data-action="go-back"]){display:none!important}' +
  '.mobile-toolbar>button[data-action="view-list"],.mobile-toolbar>button[data-action="view-grid"],.mobile-toolbar>button[data-action="toggle-theme"],.mobile-toolbar>button[data-action="go-back"]{display:flex!important}' +
  '.mobile-toolbar #breadcrumb{display:flex!important;width:100%!important;order:10!important;margin-top:4px!important;padding:8px 0!important;border-top:1px solid #1f1f22!important;overflow-x:auto!important;white-space:nowrap!important;scrollbar-width:none!important}' +
  '.mobile-toolbar #breadcrumb::-webkit-scrollbar{display:none}' +
  '.mobile-toolbar>div[style*="position:relative"]{display:block!important;flex:1;min-width:0}' +
  '#search-inp{width:100%!important;height:58px;border-radius:9999px!important;background:var(--surf-hi)!important;border:none!important;outline:none!important;color:var(--on-surf)!important;font-size:16px!important;padding-left:54px!important;font-family:Manrope,sans-serif!important}' +
  '#search-inp::placeholder{color:var(--on-surf-var)}' +
  '#search-inp::-webkit-search-decoration,#search-inp::-webkit-search-cancel-button,#search-inp::-webkit-search-results-button,#search-inp::-webkit-search-results-decoration{display:none;-webkit-appearance:none}' +
  '.mobile-toolbar>div[style*="position:relative"] span{left:20px!important;color:var(--on-surf-var)!important}' +
  '.mobile-toolbar [data-action="upload-btn"]{display:flex!important;width:64px!important;height:64px!important;padding:0!important;align-items:center;justify-content:center;box-shadow:0 18px 30px rgba(124,58,237,.28);font-size:0;flex:0 0 auto}' +
  '.mobile-toolbar [data-action="view-list"],.mobile-toolbar [data-action="view-grid"],.mobile-toolbar [data-action="toggle-theme"]{width:48px!important;height:48px!important;min-height:48px!important;padding:0!important;align-items:center;justify-content:center;flex:0 0 auto}' +
  '.mobile-toolbar [data-action="toggle-theme"]{font-size:0!important}' +
  '.mobile-toolbar [data-action="toggle-theme"]::before{content:"contrast";font-family:"Material Symbols Outlined";font-size:26px}' +
  '.mobile-toolbar [data-action="upload-btn"]::before{content:"upload";font-family:"Material Symbols Outlined";font-size:34px;font-variation-settings:"FILL" 1,"wght" 700,"GRAD" 0,"opsz" 32}' +
  '.mobile-actions{display:flex!important;padding:0 20px 28px!important;gap:10px!important;overflow-x:auto;border-bottom:0!important;background:transparent!important}' +
  '.mobile-actions button{white-space:nowrap;min-height:44px;background:var(--surf-hi);border:none;color:var(--on-surf)}' +
  '#mobile-storage{display:block!important;margin:0 20px 34px!important;padding:20px 28px!important}' +
  '#mobile-storage .disk-bar{height:8px;background:var(--surf-hi)}' +
  '#selection-bar{position:sticky;top:64px;z-index:45;margin:0 20px 14px;padding:12px!important;flex-wrap:wrap;border:none;border-radius:20px;background:var(--surf-cont);box-shadow:0 4px 16px rgba(0,0,0,.25)}' +
  '#file-scroll{padding:0 20px 20px!important;overflow:visible!important}' +
  '#file-area{display:block}' +
  '#file-area>div[style*="background:#1b1b1e"]{background:transparent!important;border:0!important;border-radius:0!important;overflow:visible!important;display:flex!important;flex-direction:column!important;gap:14px!important}' +
  '.file-row:first-child{display:none!important}' +
  '.file-row{min-height:80px;gap:14px!important;padding:16px 22px!important;background:var(--surf-cont)!important;border:none!important;border-radius:22px!important;box-shadow:0 2px 8px rgba(0,0,0,.2);transform:none!important}' +
  '.file-row.selected{box-shadow:0 0 0 2px var(--accent-color),0 4px 16px rgba(0,0,0,.25)!important;background:var(--accent-bg)!important}' +
  '.file-row>div:nth-child(4),.file-row>div:nth-child(5){display:none!important}' +
  '.file-row>div:nth-child(3){min-width:0;font-size:18px!important;line-height:24px!important;font-weight:700!important;color:var(--on-surf)!important;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
  '.file-row>div:nth-child(3)::after{content:attr(data-meta);display:block;font-size:14px;line-height:20px;color:var(--on-surf-var);font-weight:600;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
  '.file-row>div:last-child{width:auto!important;flex-shrink:0}' +
  '.file-actions{gap:6px!important;justify-content:flex-end!important}' +
  '.file-actions .btn-ghost{width:34px;height:34px;min-height:34px;padding:0!important;font-size:0!important;border:0!important;background:transparent!important;color:var(--on-surf-var)!important}' +
  '#file-area>div[style*="grid-template-columns"]{grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:22px!important}' +
  '.file-grid-item{min-height:144px;padding:18px 14px!important;align-items:flex-start!important;text-align:left!important;background:var(--surf-cont)!important;border-radius:22px!important}' +
  '.card{margin:0 20px 24px!important;padding:22px!important;border-radius:22px!important}' +
  '.mobile-bottom-nav{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:55;height:88px;align-items:center;justify-content:space-around;padding:8px 18px calc(8px + env(safe-area-inset-bottom));background:rgba(18,16,26,.92);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);border-top:1px solid rgba(60,55,70,.5)}' +
  '.bottom-nav-item{min-width:68px;height:64px;border:0;background:transparent;color:var(--on-surf-var);border-radius:22px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;font-size:12px;font-weight:800;transition:background .2s,color .2s,transform var(--m3-spring) .3s}' +
  '.bottom-nav-item.active{background:var(--accent-bg);color:var(--accent-light);transform:scale(1.08)}' +
  '.bottom-nav-item .material-symbols-outlined{font-size:30px}' +
  '#upload-panel{left:20px!important;right:20px!important;bottom:104px!important;width:auto!important;border-radius:18px!important}' +
  '#toast{left:20px!important;right:20px!important;bottom:24px!important;top:auto!important;width:auto!important}' +
  '#transfers-card{left:20px!important;right:20px!important;bottom:104px!important;width:auto!important;max-height:50vh}' +
  '#transfers-chip{right:20px!important;bottom:104px!important}' +
  '.preview-panel{position:fixed!important;left:0;right:0;bottom:0;z-index:70;width:100%!important;max-width:none!important;max-height:72dvh;border-left:0;border-top:1px solid var(--outline-var);border-radius:28px 28px 0 0;background:var(--surf-cont)}' +
  '.media-viewer{z-index:950}' +
  '.mv-top{height:58px;padding:0 12px}' +
  '.mv-bottom{flex-wrap:wrap;gap:8px;padding:10px 12px}' +
  '.mv-seek{flex-basis:100%;order:-1}' +
  '.mv-stage{padding:10px}' +
  '#file-scroll{min-height:0!important}' +
  '#file-area section{display:grid!important;grid-template-columns:1fr!important;gap:14px!important;margin-top:14px!important}' +
  '#file-area section:first-child{margin-top:0!important}' +
  '#file-area section>div{min-width:0!important}' +
  '#file-area h1{font-size:26px!important;line-height:1.12!important}' +
  '#file-area [style*="grid-template-columns:minmax(0,1fr) 170px"],#file-area [style*="grid-template-columns:minmax(0,1fr) auto auto"],#file-area [style*="grid-template-columns:repeat(4"],#file-area [style*="grid-template-columns:minmax(0,1fr) minmax(320px"],#file-area [style*="grid-template-columns:repeat(auto-fit"]{grid-template-columns:1fr!important}' +
  '#file-area [style*="grid-template-columns:1fr 1fr 1fr"]{grid-template-columns:1fr!important}' +
  '#file-area .btn-primary,#file-area .btn-ghost{min-height:46px}' +
  '#file-area [data-action="dashboard-url-download"],#file-area [data-action="upload-btn"]{width:100%;justify-content:center}' +
  '.history-row{display:grid!important;grid-template-columns:1fr!important;gap:8px!important;padding:14px!important;border-radius:16px!important;margin-bottom:10px!important;border:1px solid rgba(74,68,85,.55)!important}' +
  '.history-row>div:last-child{justify-content:flex-start!important}' +
  '#selection-bar{top:64px!important;max-height:38dvh;overflow:auto!important}' +
  '.speed-result{grid-template-columns:1fr!important}' +
  '#selection-bar .btn-ghost{min-height:38px;padding:7px 10px!important;font-size:12px!important}' +
  '#selection-count{flex-basis:100%!important}' +
  '.mobile-bottom-nav{height:78px!important;padding:6px 8px calc(6px + env(safe-area-inset-bottom))!important;gap:4px!important}' +
  '.bottom-nav-item{min-width:0!important;flex:1 1 0!important;height:58px!important;border-radius:18px!important;font-size:10px!important;line-height:12px!important}' +
  '.bottom-nav-item .material-symbols-outlined{font-size:25px!important}' +
  '.mobile-toolbar{padding:18px 14px 10px!important;gap:10px!important}' +
  '.mobile-toolbar>div[style*="position:relative"]{order:-1!important;flex-basis:100%!important}' +
  '#search-inp{height:50px!important;font-size:15px!important}' +
  '.mobile-toolbar [data-action="upload-btn"]{width:54px!important;height:54px!important}' +
  '.mobile-toolbar [data-action="view-list"],.mobile-toolbar [data-action="view-grid"],.mobile-toolbar [data-action="toggle-theme"],.mobile-toolbar [data-action="go-back"]{width:44px!important;height:44px!important;min-height:44px!important}' +
  '.mobile-actions{padding:0 14px 18px!important;gap:8px!important;scroll-snap-type:x proximity}' +
  '.mobile-actions button{scroll-snap-align:start;min-height:42px!important;padding:8px 12px!important;font-size:12px!important}' +
  '#mobile-storage{margin:0 14px 18px!important;padding:16px!important}' +
  '#file-scroll{padding:0 14px 18px!important}' +
  '#file-area>div[style*="grid-template-columns"]{gap:12px!important}' +
  '.file-grid-item{min-height:132px!important;padding:14px 12px!important}' +
  '.file-grid-item .file-thumb{width:44px!important;height:44px!important}' +
  '.file-row{min-height:72px!important;padding:14px!important;border-radius:16px!important}' +
  '.file-row>div:nth-child(3){font-size:15px!important;line-height:20px!important}' +
  '.file-row>div:nth-child(3)::after{font-size:12px!important;line-height:17px!important}' +
  '.item-menu-btn{width:38px!important;height:38px!important;min-height:38px!important}' +
  '.preview-panel{max-height:82dvh!important}' +
  '.preview-body{padding:12px!important;max-height:48dvh!important}' +
  '#preview-info{max-height:30dvh!important}' +
  '.preview-media-wrap{min-height:180px!important}' +
  '.preview-media-wrap .plyr video{max-height:44dvh!important}' +
  '.mv-top{min-height:58px!important;height:auto!important}' +
  '.mv-title{font-size:13px!important}' +
  '.mv-icon{width:38px!important;height:38px!important}' +
  '.mv-stage{padding:8px!important}' +
  '.mv-stage .plyr video{max-height:calc(100dvh - 132px)!important}' +
  '.modal-backdrop{align-items:flex-end!important;padding:10px!important;z-index:800!important}' +
  '.modal{width:100%!important;max-width:none!important;max-height:86dvh!important;overflow:auto!important;padding:22px!important;border-radius:28px 28px 16px 16px!important}' +
  '.modal .inp{font-size:16px!important;min-height:46px!important}' +
  '.modal [style*="grid-template-columns"]{grid-template-columns:1fr!important}' +
  '.modal [style*="justify-content:flex-end"]{justify-content:stretch!important}' +
  '.modal [style*="justify-content:flex-end"] .btn-primary,.modal [style*="justify-content:flex-end"] .btn-ghost{flex:1 1 0!important;justify-content:center}' +
  '#modal-share-manager .modal{max-height:92dvh!important}' +
  '#sm-list [style*="grid-template-columns:1fr 1fr"]{grid-template-columns:1fr!important}' +
  '#upload-panel{left:10px!important;right:10px!important;bottom:88px!important;max-height:70dvh!important;overflow:auto!important}' +
  '#toast{left:10px!important;right:10px!important;bottom:88px!important;width:auto!important}' +
  '#transfers-card{left:10px!important;right:10px!important;bottom:88px!important;max-height:62dvh!important}' +
  '#transfers-chip{right:10px!important;bottom:88px!important}' +
  '@media (max-width:420px){#file-area>div[style*="grid-template-columns"]{grid-template-columns:1fr!important}.mobile-brand{font-size:22px!important}.bottom-nav-item span:last-child{display:none!important}.bottom-nav-item{height:52px!important}.mobile-bottom-nav{height:70px!important}.preview-panel{max-height:86dvh!important}}' +
  '.modal-backdrop{align-items:flex-end!important;padding:10px!important}' +
  '.modal{min-width:0!important;width:100%!important;padding:22px!important;border-radius:28px 28px 16px 16px!important}' +
  '}' +
  '#sidebar-player{display:none;margin:12px 8px;padding:14px;border-radius:20px;background:var(--surf-hi);border:1px solid color-mix(in srgb,var(--accent-color) 15%,rgba(255,255,255,.05));box-shadow:0 8px 32px rgba(0,0,0,.24);flex-direction:column;gap:10px;animation:slideUpFade 0.4s var(--m3-spring) both}' +
  '@keyframes slideUpFade{from{opacity:0;transform:translateY(15px)}to{opacity:1;transform:translateY(0)}}' +
  '.player-cover-art{width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,var(--accent-color),color-mix(in srgb,var(--accent-color) 40%,#000));display:flex;align-items:center;justify-content:center;color:#fff;flex-shrink:0;box-shadow:0 4px 14px var(--accent-glow)}' +
  '.player-ctrl-btn{width:34px!important;height:34px!important;min-height:34px!important;padding:0!important;border-radius:50%!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;transition:transform 0.2s,background 0.2s!important}' +
  '.player-ctrl-btn:hover{transform:scale(1.1);background:rgba(255,255,255,0.08)!important}' +
  '.player-play-btn{width:40px;height:40px;border-radius:50%;background:var(--accent-color);color:#fff;border:none;outline:none;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 20px var(--accent-glow);transition:transform 0.25s var(--m3-spring),box-shadow 0.2s}' +
  '.player-play-btn:hover{transform:scale(1.12);box-shadow:0 8px 24px var(--accent-glow)}' +
  '.player-play-btn:active{transform:scale(0.95)}' +
  '#player-progress{-webkit-appearance:none;width:100%;height:4px;border-radius:2px;background:rgba(255,255,255,0.12);outline:none;cursor:pointer;accent-color:var(--accent-color);transition:height 0.15s}' +
  '#player-progress:hover{height:6px}' +
  '#player-progress::-webkit-slider-thumb{-webkit-appearance:none;width:10px;height:10px;border-radius:50%;background:var(--accent-color);cursor:pointer;box-shadow:0 0 8px var(--accent-glow);transition:transform 0.15s}' +
  '#player-progress:hover::-webkit-slider-thumb{transform:scale(1.3)}' +
  '.playlist-track-row:hover{background:rgba(255,255,255,0.05)!important}' +
  '</style>' +
  '</head>' +
  '<body class="flex">' +
  '<header class="mobile-topbar">' +
  '<div class="mobile-avatar"><span class="material-symbols-outlined">person</span></div>' +
  '<div class="mobile-brand">CloudSpace</div>' +
  '</header>' +
  /* ── SIDEBAR ── */
  '<aside class="sidebar flex flex-col py-6 px-4 gap-2 sticky top-0 h-screen overflow-y-auto">' +
  '<div class="flex items-center gap-3 px-2 mb-6">' +
  '<div style="background:var(--accent-gradient);border-radius:14px;width:40px;height:40px;display:flex;align-items:center;justify-content:center;font-size:20px;box-shadow:0 12px 28px var(--accent-glow);flex-shrink:0"><span class="material-symbols-outlined">cloud</span></div>' +
  '<div><div style="font-weight:800;font-size:17px;color:var(--on-surf);font-family:var(--font-display);letter-spacing:-.01em">CloudSpace</div>' +
  '<div style="font-size:11px;color:var(--outline)">' + safeUsername + '</div></div>' +
  '</div>' +
  '<a href="/" class="nav-item"><span class="material-symbols-outlined">arrow_back</span><span>Главная</span></a>' +
  '<div style="font-size:10px;font-weight:700;letter-spacing:.08em;color:var(--outline-var);text-transform:uppercase;padding:10px 4px 4px 20px">Навигация</div>' +
  '<div class="nav-item active" data-action="nav-dashboard"><span class="material-symbols-outlined">dashboard</span><span>Главная</span></div>' +
  '<div class="nav-item" data-action="nav-files"><span class="material-symbols-outlined">folder</span><span>Мои файлы</span></div>' +
  '<div class="nav-item" data-action="nav-recent"><span class="material-symbols-outlined">schedule</span><span>Недавние</span></div>' +
  '<div class="nav-item" data-action="nav-activity"><span class="material-symbols-outlined">list_alt</span><span>Активность</span></div>' +
  '<div class="nav-item" data-action="nav-settings"><span class="material-symbols-outlined">settings</span><span>Настройки</span></div>' +
  '<div style="flex:1"></div>' +
  '<audio id="global-audio" style="display:none"></audio>' +
  '<div id="sidebar-player" class="card">' +
  '  <div style="display:flex;align-items:center;gap:12px;position:relative">' +
  '    <div class="player-cover-art">' +
  '      <span class="material-symbols-outlined" style="font-size:24px">music_note</span>' +
  '    </div>' +
  '    <div id="player-text-wrap" style="min-width:0;flex:1;cursor:pointer;margin-right:48px" title="Нажмите, чтобы поменять местами Название и Исполнителя">' +
  '      <div id="player-title" style="font-size:13px;font-weight:800;color:var(--on-surf);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.2">—</div>' +
  '      <div id="player-artist" style="font-size:11px;color:#958ea0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.2;margin-top:2px">—</div>' +
  '    </div>' +
  '    <div style="position:absolute;right:-4px;top:-4px;display:flex;align-items:center;gap:2px">' +
  '      <button class="btn-ghost player-ctrl-btn" id="player-btn-details" title="Открыть детали файла" style="width:24px!important;height:24px!important;min-height:24px!important">' +
  '        <span class="material-symbols-outlined" style="font-size:15px">info</span>' +
  '      </button>' +
  '      <button class="btn-ghost player-ctrl-btn" id="player-btn-close" title="Скрыть плеер" style="width:24px!important;height:24px!important;min-height:24px!important">' +
  '        <span class="material-symbols-outlined" style="font-size:15px">close</span>' +
  '      </button>' +
  '    </div>' +
  '  </div>' +
  '  <div style="display:flex;flex-direction:column;gap:4px;margin-top:2px">' +
  '    <input type="range" id="player-progress" min="0" max="100" value="0">' +
  '    <div style="display:flex;justify-content:space-between;font-size:10px;color:#958ea0;font-weight:700">' +
  '      <span id="player-time-cur">0:00</span>' +
  '      <span id="player-time-dur">0:00</span>' +
  '    </div>' +
  '  </div>' +
  '  <div style="display:flex;align-items:center;justify-content:center;gap:10px;margin-top:2px">' +
  '    <button class="btn-ghost player-ctrl-btn" id="player-btn-repeat" title="Повтор" style="color:var(--outline)">' +
  '      <span class="material-symbols-outlined" style="font-size:20px">repeat</span>' +
  '    </button>' +
  '    <button class="btn-ghost player-ctrl-btn" id="player-btn-prev" title="Предыдущий трек">' +
  '      <span class="material-symbols-outlined" style="font-size:22px">skip_previous</span>' +
  '    </button>' +
  '    <button class="player-play-btn" id="player-btn-play" title="Воспроизведение">' +
  '      <span class="material-symbols-outlined" id="player-play-icon" style="font-size:24px">play_arrow</span>' +
  '    </button>' +
  '    <button class="btn-ghost player-ctrl-btn" id="player-btn-next" title="Следующий трек">' +
  '      <span class="material-symbols-outlined" style="font-size:22px">skip_next</span>' +
  '    </button>' +
  '    <button class="btn-ghost player-ctrl-btn" id="player-btn-playlist" title="Очередь воспроизведения">' +
  '      <span class="material-symbols-outlined" style="font-size:20px">playlist_play</span>' +
  '    </button>' +
  '  </div>' +
  '</div>' +
  '<div class="profile-card card" style="margin:0;padding:14px;background:linear-gradient(180deg,var(--accent-bg),rgba(27,27,29,.92));border-color:var(--accent-color)">' +
  '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">' +
  '<div id="profile-avatar-sidebar" style="width:38px;height:38px;border-radius:14px;background:var(--accent-gradient);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:900;font-size:16px;flex:0 0 auto">' + safeProfileInitial + '</div>' +
  '<div style="min-width:0;flex:1"><div id="profile-label-sidebar" style="font-size:14px;font-weight:900;color:#e4e1e6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + safeProfileLabel + '</div><div id="profile-meta-sidebar" style="font-size:11px;color:#958ea0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">@' + safeUsername + ' &middot; ' + safeProfileRole + '</div></div>' +
  '<button class="btn-ghost" data-action="nav-settings" title="Профиль" style="width:34px;height:34px;min-height:34px;padding:0;display:flex;align-items:center;justify-content:center"><span class="material-symbols-outlined" style="font-size:20px">manage_accounts</span></button>' +
  '</div>' +
  '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;padding:7px 9px;border:1px solid color-mix(in srgb,var(--accent-color) 34%,transparent);border-radius:10px;background:var(--accent-bg)"><span style="font-size:10px;color:#958ea0;text-transform:uppercase;letter-spacing:.08em;font-weight:900">Версия сайта</span><span style="font-size:11px;color:var(--accent-light);font-weight:900">v' + SITE_VERSION + '</span></div>' +
  '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px"><span style="font-size:11px;color:#958ea0">Диск</span><span style="font-size:11px;color:#cbc3d7" id="disk-label">Загрузка...</span></div>' +
  '<div class="disk-bar"><div class="disk-fill" id="disk-fill" style="width:0%"></div></div>' +
  '</div>' +
  '</aside>' +
  /* ── MAIN ── */
  '<main id="main-area" class="flex-1 flex flex-col" style="min-width:0">' +
  '<div class="desktop-toolbar mobile-toolbar" style="background:rgba(19,19,23,.82);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);border-bottom:1px solid rgba(255,255,255,.06);padding:10px 24px;display:flex;align-items:center;gap:12px;flex-shrink:0">' +
  '<button id="go-back-btn" class="btn-ghost" data-action="go-back" data-drop-path="" title="Назад" style="padding:6px 10px;flex-shrink:0"><span class="material-symbols-outlined">arrow_back</span></button>' +
  '<div id="breadcrumb" style="flex:1;min-width:0;display:flex;align-items:center;flex-wrap:wrap;font-size:14px;color:var(--on-surf-var)"></div>' +
  '<div id="toolbar-search-wrap" style="display:none;position:relative;flex-shrink:0">' +
  '<input id="search-inp" type="text" role="searchbox" placeholder="Search files, folders..." style="width:260px;padding:10px 16px 10px 44px;border-radius:9999px;background:var(--surf-hi);border:none;outline:none;font-size:14px;height:42px;color:var(--on-surf);font-family:Manrope,sans-serif" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-form-type="other" data-lpignore="true" data-1p-ignore tabindex="0">' +
  '<span class="material-symbols-outlined" style="position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--accent-light);font-size:20px;pointer-events:none">search</span>' +
  '</div>' +
  '<button id="toolbar-view-list" class="btn-ghost" data-action="view-list" title="Список" style="width:40px;height:40px;padding:0;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center"><span class="material-symbols-outlined" style="font-size:20px">view_list</span></button>' +
  '<button id="toolbar-view-grid" class="btn-ghost" data-action="view-grid" title="Сетка" style="width:40px;height:40px;padding:0;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center"><span class="material-symbols-outlined" style="font-size:20px">grid_view</span></button>' +
  '<button id="toolbar-theme" class="btn-ghost" data-action="toggle-theme" title="Тема" style="width:40px;height:40px;padding:0;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center"><span class="material-symbols-outlined" style="font-size:20px">contrast</span></button>' +
  '<button id="toolbar-upload" class="btn-primary" data-action="upload-btn" style="flex-shrink:0;gap:6px;display:flex;align-items:center"><span class="material-symbols-outlined" style="font-size:18px;font-variation-settings:\'FILL\' 1,\'wght\' 700,\'GRAD\' 0,\'opsz\' 20">upload</span>Загрузить</button>' +
  '</div>' +
  '<section id="mobile-storage" class="card" style="display:none">' +
  '<div style="display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:18px">' +
  '<h2 style="font-size:24px;line-height:30px;font-weight:800;color:#fff;margin:0">Storage</h2>' +
  '<div style="font-size:16px;color:#ccc3d8;font-weight:700" id="mobile-disk-label">Загрузка...</div>' +
  '</div>' +
  '<div class="disk-bar"><div class="disk-fill" id="mobile-disk-fill" style="width:0%"></div></div>' +
  '</section>' +
  '<div class="mobile-actions" style="padding:12px 24px;display:flex;align-items:center;gap:10px;border-bottom:1px solid #1f1f22;flex-shrink:0">' +
  '<input type="file" id="upload-input" multiple style="display:none">' +
  '<button class="btn-ghost" data-action="open-url-modal"><span class="material-symbols-outlined">link</span> URL</button>' +
  '<button class="btn-ghost" data-action="mkdir"><span class="material-symbols-outlined">create_new_folder</span> Новая папка</button>' +
  '</div>' +
  '<div id="selection-bar">' +
  '<div id="selection-count" style="font-size:13px;font-weight:600;color:#d0bcff;flex:1">0 selected</div>' +
  '<button class="btn-ghost" data-action="download-selected">Скачать всё</button>' +
  '<button class="btn-ghost" data-action="zip-selected">Скачать архивом</button>' +
  '<button class="btn-ghost" data-action="share-selected">Публичная ссылка</button>' +
  '<button class="btn-ghost" data-action="clear-selection">Сбросить</button>' +
  '<button class="btn-ghost" data-action="delete-selected" style="color:#ffb4ab;border-color:#93000a">Удалить</button>' +
  '</div>' +
  '<div id="file-scroll" style="flex:1;overflow-y:auto;padding:16px 24px">' +
  '<div id="file-area"><div style="color:#958ea0;padding:40px;text-align:center">Загрузка...</div></div>' +
  '</div>' +
  '<div id="transfers-card" class="card">' +
  '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px"><div style="font-size:13px;font-weight:700;color:#cbc3d7;flex:1">Активные загрузки</div><button class="btn-ghost" data-action="minimize-transfers" style="padding:4px 8px" title="Свернуть"><span class="material-symbols-outlined">remove</span></button></div>' +
  '<div id="transfers-list"><div style="color:#494454;font-size:13px">Нет активных загрузок</div></div>' +
  '</div>' +
  '<div id="transfers-chip" data-action="restore-transfers"><span class="material-symbols-outlined">downloading</span><span id="transfers-chip-text">Загрузка...</span></div>' +
  '</main>' +
  '<nav class="mobile-bottom-nav">' +
  '<button class="bottom-nav-item active" data-action="nav-dashboard"><span class="material-symbols-outlined">home</span><span>Главная</span></button>' +
  '<button class="bottom-nav-item" data-action="nav-files"><span class="material-symbols-outlined">folder</span><span>Файлы</span></button>' +
  '<button class="bottom-nav-item" data-action="nav-recent"><span class="material-symbols-outlined">schedule</span><span>Недавние</span></button>' +
  '<button class="bottom-nav-item" data-action="nav-activity"><span class="material-symbols-outlined">list_alt</span><span>Активность</span></button>' +
  '<button class="bottom-nav-item" data-action="nav-settings"><span class="material-symbols-outlined">settings</span><span>Настройки</span></button>' +
  '<button class="bottom-nav-item" data-action="upload-btn"><span class="material-symbols-outlined">upload</span><span>Загрузить</span></button>' +
  '</nav>' +
  '<aside id="preview-panel" class="preview-panel">' +
  '<div id="preview-resizer" class="preview-resizer"></div>' +
  '<div class="preview-head">' +
  '<div id="preview-title" style="font-weight:700;font-size:17px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font-display);color:var(--on-surf)">Детали</div>' +
  '<button id="preview-btn-prev" class="btn-ghost" data-action="preview-prev" style="padding:5px 9px;display:none" title="Предыдущий"><span class="material-symbols-outlined">navigate_before</span></button>' +
  '<button id="preview-btn-next" class="btn-ghost" data-action="preview-next" style="padding:5px 9px;display:none" title="Следующий"><span class="material-symbols-outlined">navigate_next</span></button>' +
  '<button class="btn-ghost" data-action="fullscreen-preview" style="padding:5px 9px" title="На весь экран"><span class="material-symbols-outlined">open_in_full</span></button>' +
  '<button class="btn-ghost" data-action="close-preview" style="padding:5px 9px" title="Закрыть"><span class="material-symbols-outlined">close</span></button>' +
  '</div>' +
  '<div id="preview-body" class="preview-body"></div>' +
  '<div id="preview-info"></div>' +
  '</aside>' +
  /* ── CONTEXT MENU ── */
  '<div id="media-viewer" class="media-viewer">' +
  '<div class="mv-top"><div id="mv-title" class="mv-title">Media</div><button class="mv-icon" data-action="playlist-prev" title="Предыдущий"><span class="material-symbols-outlined">navigate_before</span></button><button class="mv-icon" data-action="playlist-next" title="Следующий"><span class="material-symbols-outlined">navigate_next</span></button><button class="mv-icon" id="mv-btn-screenshot" data-action="mv-screenshot" title="Сделать скриншот" style="display:none"><span class="material-symbols-outlined">photo_camera</span></button><button class="mv-icon" data-action="mv-download" title="Скачать"><span class="material-symbols-outlined">download</span></button><button class="mv-icon" data-action="mv-share" title="Публичная ссылка"><span class="material-symbols-outlined">link</span></button><button class="mv-icon" data-action="mv-close" title="Закрыть"><span class="material-symbols-outlined">close</span></button></div>' +
  '<div id="mv-stage" class="mv-stage"></div>' +
  '<div id="mv-bottom" class="mv-bottom"></div>' +
  '</div>' +
  '<div id="ctx-menu"></div>' +
'<div id="toast" style="display:none;flex-direction:column;gap:14px;box-sizing:border-box">' +
  '  <div style="display:flex;justify-content:space-between;align-items:center;width:100%">' +
  '    <div id="toast-title" style="font-weight:800;font-size:16px;font-family:var(--font-display);color:#fff">Поделиться ссылкой</div>' +
  '    <button class="btn-ghost" data-action="hide-toast" style="padding:4px;min-height:auto;min-width:auto;border-color:transparent;border-radius:50%;color:#958ea0;display:flex;align-items:center;justify-content:center;background:transparent" title="Закрыть"><span class="material-symbols-outlined" style="font-size:18px">close</span></button>' +
  '  </div>' +
  '  <div id="toast-body" style="font-size:12px;color:#958ea0;word-break:break-all;line-height:1.4"></div>' +
  '  <div id="toast-share-actions" style="display:flex;justify-content:space-around;align-items:center;margin-top:4px;width:100%">' +
  '    <div style="display:flex;flex-direction:column;align-items:center;gap:6px;cursor:pointer" data-action="copy-toast">' +
  '      <div class="toast-circle" style="width:54px;height:54px;border-radius:50%;background:color-mix(in srgb,var(--accent-color) 12%,#1b1b1e);border:1px solid color-mix(in srgb,var(--accent-color) 20%,transparent);display:flex;align-items:center;justify-content:center;transition:transform .2s cubic-bezier(.4,0,.2,1)">' +
  '        <span class="material-symbols-outlined" style="color:var(--accent-light);font-size:22px">content_copy</span>' +
  '      </div>' +
  '      <span style="font-size:11px;font-weight:600;color:#958ea0">Копировать</span>' +
  '    </div>' +
  '    <div style="display:flex;flex-direction:column;align-items:center;gap:6px;cursor:pointer" data-action="open-toast-qr">' +
  '      <div class="toast-circle" style="width:54px;height:54px;border-radius:50%;background:color-mix(in srgb,var(--accent-color) 12%,#1b1b1e);border:1px solid color-mix(in srgb,var(--accent-color) 20%,transparent);display:flex;align-items:center;justify-content:center;transition:transform .2s cubic-bezier(.4,0,.2,1)">' +
  '        <span class="material-symbols-outlined" style="color:var(--accent-light);font-size:22px">qr_code_2</span>' +
  '      </div>' +
  '      <span style="font-size:11px;font-weight:600;color:#958ea0">QR-код</span>' +
  '    </div>' +
  '    <div style="display:flex;flex-direction:column;align-items:center;gap:6px;cursor:pointer" data-action="open-toast-link">' +
  '      <div class="toast-circle" style="width:54px;height:54px;border-radius:50%;background:color-mix(in srgb,var(--accent-color) 12%,#1b1b1e);border:1px solid color-mix(in srgb,var(--accent-color) 20%,transparent);display:flex;align-items:center;justify-content:center;transition:transform .2s cubic-bezier(.4,0,.2,1)">' +
  '        <span class="material-symbols-outlined" style="color:var(--accent-light);font-size:22px">open_in_new</span>' +
  '      </div>' +
  '      <span style="font-size:11px;font-weight:600;color:#958ea0">Перейти</span>' +
  '    </div>' +
  '  </div>' +
  '</div>' +
  '<div id="connection-pill"><span class="dot"></span><span id="connection-text">Проверяю соединение...</span></div>' +
  /* ── DROP ZONE ── */
  '<div id="drop-zone">' +
  '<div style="font-size:48px">\u{1F4E5}</div>' +
  '<div style="font-size:20px;font-weight:700;color:#d0bcff">Перетащите файлы для загрузки</div>' +
  '<div style="font-size:13px;color:#958ea0">Отпустите, чтобы загрузить в текущую папку</div>' +
  '</div>' +
  /* ── MKDIR MODAL ── */
  '<div id="upload-panel">' +
  '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">' +
  '<div id="upload-title" style="font-size:13px;font-weight:700;color:#e4e1e6;flex:1">Upload</div>' +
  '<button class="btn-ghost" data-action="hide-upload-panel" style="padding:3px 8px;font-size:12px">x</button>' +
  '</div>' +
  '<div id="upload-files" style="display:flex;flex-direction:column;gap:4px;margin-bottom:10px"></div>' +
  '<div class="progress-track" style="height:8px;margin-bottom:8px"><div id="upload-fill" class="progress-fill" style="width:0%"></div></div>' +
  '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px">' +
  '<div id="upload-status" style="font-size:13px;font-weight:700;color:var(--accent-light);min-width:36px">0%</div>' +
  '<div id="upload-speed" style="font-size:12px;color:#8ff0a4"></div>' +
  '</div>' +
  '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">' +
  '<div id="upload-bytes" style="font-size:11px;color:#958ea0"></div>' +
  '<div style="font-size:11px;color:#958ea0">ETA: <span id="upload-eta">-</span></div>' +
  '</div>' +
  '</div>' +
  '<div id="modal-mkdir" class="modal-backdrop" style="display:none">' +
  '<div class="modal">' +
  '<div style="font-weight:700;font-size:18px;margin-bottom:16px">Новая папка</div>' +
  '<input id="mkdir-name" class="inp" placeholder="Название папки" style="margin-bottom:16px">' +
  '<div style="display:flex;gap:10px;justify-content:flex-end">' +
  '<button class="btn-ghost" data-action="close-mkdir">Отмена</button>' +
  '<button class="btn-primary" data-action="confirm-mkdir">Создать</button>' +
  '</div></div></div>' +
  /* ── RENAME MODAL ── */
  '<div id="modal-rename" class="modal-backdrop" style="display:none">' +
  '<div class="modal">' +
  '<div style="font-weight:700;font-size:18px;margin-bottom:16px">Переименовать</div>' +
  '<div style="display:flex;align-items:center;margin-bottom:16px">' +
  '<input id="rename-inp" class="inp" style="flex:1;min-width:0;border-top-right-radius:0;border-bottom-right-radius:0">' +
  '<div id="rename-ext" class="inp" style="display:none;width:auto;flex:0 0 auto;border-left:0;border-top-left-radius:0;border-bottom-left-radius:0;color:#958ea0;background:#121216"></div>' +
  '</div>' +
  '<div style="display:flex;gap:10px;justify-content:flex-end">' +
  '<button class="btn-ghost" data-action="close-rename">Отмена</button>' +
  '<button class="btn-primary" data-action="confirm-rename">Сохранить</button>' +
  '</div></div></div>' +
  '<div id="modal-url" class="modal-backdrop" style="display:none">' +
  '<div class="modal" style="width:520px">' +
  /* header */
  '<div style="display:flex;align-items:center;gap:14px;margin-bottom:22px">' +
  '<div style="width:48px;height:48px;border-radius:16px;background:var(--accent-bg);display:flex;align-items:center;justify-content:center;flex-shrink:0">' +
  '<span class="material-symbols-outlined" style="color:var(--accent-color);font-size:26px;font-variation-settings:\'FILL\' 1">download</span>' +
  '</div>' +
  '<div><div style="font-weight:700;font-size:20px;font-family:var(--font-display);color:var(--on-surf)">Загрузить по URL</div>' +
  '<div style="font-size:13px;color:var(--on-surf-var);margin-top:3px">Файл попадёт в текущую папку CloudSpace</div>' +
  '</div></div>' +
  /* batch toggle */
  '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
  '  <div style="font-size:11px;font-weight:600;color:var(--on-surf-var);text-transform:uppercase;letter-spacing:.8px">Ссылка для загрузки</div>' +
  '  <button class="btn-ghost" id="url-toggle-batch" onclick="toggleUrlBatchMode()" style="padding:4px 8px;font-size:11px;border-radius:8px;min-height:24px;color:var(--accent-light)">Несколько ссылок</button>' +
  '</div>' +
  /* url input */
  '<div class="url-dl-inp-wrap" style="margin-bottom:14px">' +
  '<span class="material-symbols-outlined url-inp-icon">link</span>' +
  '<input id="url-dl-inp" type="text" placeholder="https://example.com/file.zip или ссылка YouTube..." autocomplete="off" data-form-type="other" data-lpignore="true" data-1p-ignore>' +
  '<textarea id="url-dl-inp-batch" style="display:none;width:100%;height:100px;border-radius:14px;border:1.5px solid var(--outline-var);padding:10px 14px;background:var(--surf-hi);color:var(--on-surf);font-size:13px;font-family:monospace;resize:none;outline:none;box-sizing:border-box;transition:border-color .2s,box-shadow .2s;margin-top:2px" placeholder="Вставьте одну или несколько ссылок, каждую с новой строки..." onfocus="this.style.borderColor=\'var(--accent-color)\';this.style.boxShadow=\'0 0 0 3px color-mix(in srgb,var(--accent-color) 18%,transparent)\'" onblur="this.style.borderColor=\'var(--outline-var)\';this.style.boxShadow=\'none\'"></textarea>' +
  '</div>' +
  /* mode label */
  '<div style="font-size:11px;font-weight:600;color:var(--on-surf-var);text-transform:uppercase;letter-spacing:.8px;margin-bottom:10px">Тип загрузки</div>' +
  /* hidden select used by addUrlDownload */
  '<select id="url-mode-inp" style="display:none"><option value="file">file</option><option value="video">video</option><option value="audio">audio</option><option value="best">best</option></select>' +
  /* cards 2×2 */
  '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:18px">' +
  '<div id="url-card-file" class="url-mode-card selected" onclick="selectUrlMode(\'file\')">' +
  '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">' +
  '<div style="width:36px;height:36px;border-radius:10px;background:color-mix(in srgb,var(--accent-color) 16%,transparent);display:flex;align-items:center;justify-content:center">' +
  '<span class="material-symbols-outlined" style="font-size:20px;color:var(--accent-color);font-variation-settings:\'FILL\' 1">insert_drive_file</span>' +
  '</div>' +
  '<div style="font-size:14px;font-weight:700;color:var(--on-surf)">Файл</div>' +
  '</div>' +
  '<div style="font-size:12px;color:var(--on-surf-var);line-height:1.45">Прямая ссылка на любой файл</div>' +
  '</div>' +
  '<div id="url-card-video" class="url-mode-card" onclick="selectUrlMode(\'video\')">' +
  '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">' +
  '<div style="width:36px;height:36px;border-radius:10px;background:rgba(255,100,80,.13);display:flex;align-items:center;justify-content:center">' +
  '<span class="material-symbols-outlined" style="font-size:20px;color:#ff6454;font-variation-settings:\'FILL\' 1">movie</span>' +
  '</div>' +
  '<div style="font-size:14px;font-weight:700;color:var(--on-surf)">Видео</div>' +
  '</div>' +
  '<div style="font-size:12px;color:var(--on-surf-var);line-height:1.45">YouTube, Vimeo и другие площадки</div>' +
  '</div>' +
  '<div id="url-card-audio" class="url-mode-card" onclick="selectUrlMode(\'audio\')">' +
  '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">' +
  '<div style="width:36px;height:36px;border-radius:10px;background:rgba(80,180,255,.13);display:flex;align-items:center;justify-content:center">' +
  '<span class="material-symbols-outlined" style="font-size:20px;color:#50b4ff;font-variation-settings:\'FILL\' 1">music_note</span>' +
  '</div>' +
  '<div style="font-size:14px;font-weight:700;color:var(--on-surf)">MP3 аудио</div>' +
  '</div>' +
  '<div style="font-size:12px;color:var(--on-surf-var);line-height:1.45">Извлечь аудиодорожку в MP3</div>' +
  '</div>' +
  '<div id="url-card-best" class="url-mode-card" onclick="selectUrlMode(\'best\')">' +
  '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">' +
  '<div style="width:36px;height:36px;border-radius:10px;background:rgba(180,120,255,.13);display:flex;align-items:center;justify-content:center">' +
  '<span class="material-symbols-outlined" style="font-size:20px;color:#b478ff;font-variation-settings:\'FILL\' 1">hd</span>' +
  '</div>' +
  '<div style="font-size:14px;font-weight:700;color:var(--on-surf)">Лучшее качество</div>' +
  '</div>' +
  '<div style="font-size:12px;color:var(--on-surf-var);line-height:1.45">Наилучший доступный медиаформат</div>' +
  '</div>' +
  '</div>' + /* end grid */
  /* optional filename */
  '<input id="url-name-inp" type="text" placeholder="Имя без расширения (необязательно)" autocomplete="off" data-form-type="other" data-lpignore="true" data-1p-ignore>' +
  '<div id="url-name-hint" style="font-size:11px;color:var(--on-surf-var);margin-bottom:14px">Для медиа расширение добавится автоматически: .mp4 или .mp3</div>' +
  /* status */
  '<div id="url-status" style="font-size:12px;color:var(--on-surf-var);min-height:18px;margin-bottom:14px"></div>' +
  /* buttons */
  '<div style="display:flex;gap:10px;justify-content:flex-end">' +
  '<button class="btn-ghost" data-action="close-url-modal">Отмена</button>' +
  '<button class="btn-primary" data-action="confirm-url-download" style="display:inline-flex;align-items:center;gap:8px">' +
  '<span class="material-symbols-outlined" style="font-size:18px;font-variation-settings:\'FILL\' 1">download</span>Загрузить' +
  '</button>' +
  '</div></div></div>' +
  '<div id="modal-share" class="modal-backdrop" style="display:none">' +
  '<div class="modal" style="width:460px">' +
  '<div style="font-weight:700;font-size:18px;margin-bottom:6px">Публичная ссылка</div>' +
  '<div id="share-target-label" style="font-size:12px;color:#958ea0;margin-bottom:14px">Настройки доступа</div>' +
  '<label style="display:block;font-size:12px;color:#958ea0;margin-bottom:6px">Срок действия</label>' +
  '<select id="share-expire-inp" class="inp" style="margin-bottom:12px">' +
  '<option value="0">Без ограничения</option><option value="1">1 час</option><option value="24">1 день</option><option value="72">3 дня</option><option value="168">7 дней</option><option value="720">30 дней</option>' +
  '</select>' +
  '<label style="display:block;font-size:12px;color:#958ea0;margin-bottom:6px">Количество скачиваний</label>' +
  '<input id="share-max-inp" class="inp" type="number" min="0" step="1" placeholder="0 = без ограничения" style="margin-bottom:12px">' +
  '<label style="display:block;font-size:12px;color:#958ea0;margin-bottom:6px">Пароль для защиты ссылки (опционально)</label>' +
  '<input id="share-password-inp" class="inp" type="password" placeholder="Оставьте пустым, если пароль не нужен" style="margin-bottom:12px">' +
  '<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#958ea0;margin-bottom:12px;cursor:pointer">' +
  '<input type="checkbox" id="share-preview-chk" checked style="cursor:pointer"> Создать страницу предпросмотра (вместо авто-скачивания)' +
  '</label>' +
  '<div id="share-status" style="font-size:12px;color:#958ea0;min-height:16px;margin-bottom:12px"></div>' +
  '<div style="display:flex;gap:10px;justify-content:flex-end">' +
  '<button class="btn-ghost" data-action="close-share-modal">Отмена</button>' +
  '<button class="btn-primary" data-action="confirm-share">Создать ссылку</button>' +
  '</div></div></div>' +
  '<div id="modal-qr" class="modal-backdrop" style="display:none">' +
  '<div class="modal" style="width:380px;text-align:center">' +
  '<div style="font-weight:700;font-size:18px;margin-bottom:6px">QR-код ссылки</div>' +
  '<div id="qr-link-text" style="font-size:12px;color:#958ea0;word-break:break-all;margin-bottom:14px"></div>' +
  '<div style="background:#fff;border-radius:14px;padding:14px;display:inline-flex;margin-bottom:14px"><img id="qr-img" alt="QR code" style="width:260px;height:260px;display:block"></div>' +
  '<div style="display:flex;gap:10px;justify-content:center">' +
  '<a id="qr-open-link" class="btn-ghost" target="_blank" rel="noopener" style="text-decoration:none">Открыть</a>' +
  '<button class="btn-ghost" data-action="copy-toast">Копировать</button>' +
  '<button class="btn-primary" data-action="close-qr">Готово</button>' +
  '</div></div></div>' +
  '<div id="modal-playlist" class="modal-backdrop" style="display:none">' +
  '<div class="modal" style="width:min(500px,94vw);max-height:80vh;display:flex;flex-direction:column;padding:20px;border-radius:24px;background:var(--surf-hi);border:1px solid rgba(255,255,255,.05)">' +
  '  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;gap:12px">' +
  '    <span class="material-symbols-outlined" style="color:var(--accent-color);font-size:26px">queue_music</span>' +
  '    <div style="font-weight:800;font-size:18px;color:var(--on-surf);flex:1">Очередь воспроизведения</div>' +
  '    <button class="btn-ghost" id="playlist-modal-close" style="padding:4px 8px;font-size:14px;border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center"><span class="material-symbols-outlined" style="font-size:20px">close</span></button>' +
  '  </div>' +
  '  <div id="playlist-modal-tracks" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:8px;margin-bottom:12px;max-height:50vh"></div>' +
  '</div></div>' +
  '<div id="modal-share-manager" class="modal-backdrop" style="display:none">' +
  '<div class="modal" style="width:min(760px,94vw);max-height:86vh;overflow:auto">' +
  '<div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:14px">' +
  '<div style="flex:1"><div style="font-weight:800;font-size:18px;margin-bottom:4px">Публичные ссылки</div><div id="sm-file-label" style="font-size:12px;color:#958ea0;word-break:break-all"></div></div>' +
  '<button class="btn-ghost" data-action="close-share-manager" style="padding:6px 10px"><span class="material-symbols-outlined">close</span></button>' +
  '</div>' +
  '<div id="sm-status" style="font-size:12px;color:#958ea0;min-height:16px;margin-bottom:10px"></div>' +
  '<div id="sm-list"></div>' +
  '<div style="border-top:1px solid #353437;margin-top:14px;padding-top:14px">' +
  '<div style="font-weight:700;font-size:14px;margin-bottom:10px">Создать новую ссылку</div>' +
  '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">' +
  '<select id="sm-new-expire" class="inp"><option value="0">Без ограничения</option><option value="1">1 час</option><option value="24">1 день</option><option value="72">3 дня</option><option value="168">7 дней</option><option value="720">30 дней</option></select>' +
  '<input id="sm-new-max" class="inp" type="number" min="0" step="1" placeholder="Скачиваний: 0 = без лимита">' +
  '</div>' +
  '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">' +
  '<input id="sm-new-password" class="inp" type="password" placeholder="Пароль (опционально)">' +
  '<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#958ea0;cursor:pointer"><input type="checkbox" id="sm-new-preview" checked> Страница предпросмотра</label>' +
  '</div>' +
  '<div style="display:flex;justify-content:flex-end;margin-top:10px"><button class="btn-primary" data-action="sm-create"><span class="material-symbols-outlined">add_link</span> Создать ссылку</button></div>' +
  '</div>' +
  '</div></div>' +
  '<script>' +
  'var userIsAdmin = ' + (profile.isAdmin ? 'true' : 'false') + ';' +
  'var activeFilter = "all";' +
  'var currentPath="__dashboard__",currentView=localStorage.getItem("fm-view")||"list";' +
  'if(currentView!=="grid")currentView="list";' +
  'function encPath(p){return (p||"").split("/").filter(Boolean).map(encodeURIComponent).join("/");}' +
  'function decPath(p){return (p||"").split("/").filter(Boolean).map(function(x){try{return decodeURIComponent(x);}catch(e){return x;}}).join("/");}' +
  'function hashForPath(p){if(p==="__dashboard__")return "dashboard";if(p==="__recent__")return "recent";if(p==="__activity__")return "activity";if(p==="__settings__")return "settings";return p?"files/"+encPath(p):"files";}' +
  'function parseHash(){var h=(window.location.hash||"").replace(/^#/,"");if(!h)return null;if(h==="dashboard"||h==="__dashboard__")return {type:"dashboard"};if(h==="recent"||h==="__recent__")return {type:"recent"};if(h==="activity"||h==="__activity__")return {type:"activity"};if(h==="settings"||h==="__settings__")return {type:"settings"};if(h==="files")return {type:"files",path:""};if(h.indexOf("files/")===0)return {type:"files",path:decPath(h.slice(6))};return {type:"files",path:decPath(h)};}' +
  'function savePath(p){try{localStorage.setItem("fm-path",p);if(!window._ignoreHash){var next="#"+hashForPath(p);if(window.location.hash!==next)window.location.hash=next;}}catch(e){}}' +
  'function handleHash(){' +
  '  var h=parseHash();if(!h)h={type:"dashboard"};' +
  '  var target=h.type==="dashboard"?"__dashboard__":h.type==="recent"?"__recent__":h.type==="activity"?"__activity__":h.type==="settings"?"__settings__":(h.path||"");' +
  '  if(target===currentPath)return;' +
  '  window._ignoreHash=true;' +
  '  if(h.type==="dashboard")loadDashboard();' +
  '  else if(h.type==="recent")loadRecent();' +
  '  else if(h.type==="activity")loadActivityLog();' +
  '  else if(h.type==="settings")loadCloudSettings();' +
  '  else navigateTo(h.path||"");' +
  '  window._ignoreHash=false;' +
  '}' +
  'window.addEventListener("hashchange",handleHash);' +
  'var renameFp="",renameIsDir=false,renameExt="";' +
  'var ctxFp="",ctxName="",ctxIsDir=false;' +
  'var dragFp=null,dragName=null,dragIsDir=false,dragEl=null,dragItems=null,dragGhostEl=null;' +
  'var selectedItems={},lastEntries=[],lastBase="";' +
  'var previewFp="",previewName="",previewKind="",previewSrc="",mvZoom=1;' +
  'var activeAudioFp="",activeAudioName="",currentAudioQueue=[],sidebarPlayerInitialized=false;' +
  'var urlBatchMode=false,dashUrlBatchMode=false;' +
  'var toastUrl="";' +
  'var pendingShare=null;' +
  'var shareManagerFp="",shareManagerName="";' +
  'var transfersMinimized=localStorage.getItem("transfers-minimized")==="1";' +
  'var knownMediaStatuses={};' +
  'var pendingUrlJobs={};try{pendingUrlJobs=JSON.parse(localStorage.getItem("pending-url-jobs")||"{}")||{};}catch(e){pendingUrlJobs={};}' +
  'var recentNewFiles={};' +
  'var uploadBusy=false;' +
  /* ── UTILS ── */
  'function H(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}' +
  'function highlightCode(code,ext){' +
  '  var escaped=H(code);' +
  '  var store=[];' +
  '  function mask(str,cls){' +
  '    var placeholder="___MASKED_"+store.length+"___";' +
  '    store.push({value:str,cls:cls});' +
  '    return placeholder;' +
  '  }' +
  '  var temp=escaped;' +
  '  temp=temp.replace(/(&quot;|&#39;|\\\'|\'|`)(?:\\\\.|[^\\\\])*?\\\\1/g,function(m){' +
  '    return mask(m,"code-hl-str");' +
  '  });' +
  '  if(["html","xml"].includes(ext)){' +
  '    temp=temp.replace(/&lt;!--[\\\\s\\\\S]*?--&gt;/g,function(m){' +
  '      return mask(m,"code-hl-cmt");' +
  '    });' +
  '  }else{' +
  '    temp=temp.replace(/\\/\\*[\\\\s\\\\S]*?\\*\\//g,function(m){' +
  '      return mask(m,"code-hl-cmt");' +
  '    });' +
  '    temp=temp.replace(/\\/\\/.*$/gm,function(m){' +
  '      return mask(m,"code-hl-cmt");' +
  '    });' +
  '    temp=temp.replace(/#.*$/gm,function(m){' +
  '      return mask(m,"code-hl-cmt");' +
  '    });' +
  '  }' +
  '  if(["html","xml","svg"].includes(ext)){' +
  '    temp=temp.replace(/(&lt;\\/?)([\\\\w:-]+)(.*?)(\\/?&gt;)/g,function(match,open,tag,attrs,close){' +
  '      var highlightedAttrs=attrs.replace(/(\\b[\\\\w:-]+)(=)/g,\'<span class="code-hl-attr">$1</span>$2\');' +
  '      return open+\'<span class="code-hl-tag">\'+tag+\'</span>\'+highlightedAttrs+close;' +
  '    });' +
  '  }else{' +
  '    var keywords=/\\b(break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|function|if|import|in|instanceof|new|return|super|switch|this|throw|try|typeof|var|void|while|with|yield|def|elif|lambda|import|from|as|global|nonlocal|pass|raise|try|except|finally|with|and|or|not|is|in)\\b/g;' +
  '    var builtins=/\\b(console|document|window|Object|Array|String|Number|Boolean|Function|Promise|JSON|Map|Set|dict|list|tuple|set|int|str|float|print|len|range|self)\\b/g;' +
  '    temp=temp.replace(keywords,\'<span class="code-hl-kw">$1</span>\');' +
  '    temp=temp.replace(builtins,\'<span class="code-hl-fn">$1</span>\');' +
  '    temp=temp.replace(/\\b(\\d+(?:\\.\\d+)?)\\b/g,\'<span class="code-hl-num">$1</span>\');' +
  '  }' +
  '  for(var i=store.length-1;i>=0;i--){' +
  '    var placeholder="___MASKED_"+i+"___";' +
  '    var item=store[i];' +
  '    temp=temp.replace(placeholder,\'<span class="\'+item.cls+\'">\'+item.value+\'</span>\');' +
  '  }' +
  '  return temp;' +
  '}' +
  'function fmtSize(b){if(!b)return "0 B";var u=["B","KB","MB","GB"],i=0;while(b>=1024&&i<3){b/=1024;i++;}return b.toFixed(i?1:0)+" "+u[i];}' +
  'function fmtSpeed(b){return fmtSize(b||0)+"/s";}' +
  'function fmtDate(ts){if(!ts)return "";return new Date(ts).toLocaleDateString("ru-RU",{day:"2-digit",month:"short",year:"numeric"});}' +
  'function fmtDateTime(ts){if(!ts)return "";return new Date(ts).toLocaleString("ru-RU",{day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"});}' +
  'function activePath(){return (currentPath==="__dashboard__"||currentPath==="__recent__"||currentPath==="__activity__"||currentPath==="__url_history__"||currentPath==="__settings__")?"":currentPath;}' +
  'function setNavActive(action){document.querySelectorAll(".nav-item,.bottom-nav-item").forEach(function(x){x.classList.toggle("active",x.dataset.action===action);});}' +
  'function parentPath(p){var parts=(p||"").split("/").filter(Boolean);parts.pop();return parts.join("/");}' +
  'function splitExt(name,isDir){if(isDir)return {base:name,ext:""};var dot=name.lastIndexOf(".");if(dot<=0)return {base:name,ext:""};return {base:name.slice(0,dot),ext:name.slice(dot)};}' +
  'function setView(v){currentView=v==="grid"?"grid":"list";localStorage.setItem("fm-view",currentView);if(currentPath!=="__recent__"&&currentPath!=="__url_history__")loadDir();}' +
  'function selectedList(){return Object.keys(selectedItems).map(function(k){return selectedItems[k];});}' +
  'function updateSelectionBar(){var n=selectedList().length;document.getElementById("selection-count").textContent="Выбрано: "+n;document.getElementById("selection-bar").style.display=n?"flex":"none";}' +
  'function clearSelection(refresh){selectedItems={};updateSelectionBar();if(refresh)renderContent(lastEntries,lastBase);}' +
  'function toggleSelect(fp,name,isDir,checked){if(checked)selectedItems[fp]={fp:fp,name:name,isDir:isDir};else delete selectedItems[fp];updateSelectionBar();renderContent(lastEntries,lastBase);}' +
  'function selectAllVisible(checked){selectedItems={};if(checked){for(var i=0;i<lastEntries.length;i++){var f=lastEntries[i];var fp=lastBase?(lastBase+"/"+f.name):f.name;selectedItems[fp]={fp:fp,name:f.name,isDir:!!f.isDir};}}updateSelectionBar();renderContent(lastEntries,lastBase);}' +
  'function refreshCurrent(){if(currentPath==="__dashboard__")loadDashboard();else if(currentPath==="__recent__")loadRecent();else if(currentPath==="__activity__")loadActivityLog();else if(currentPath==="__settings__")loadCloudSettings();else loadDir();}' +
  'function goBackPath(){var p=activePath();if(!p)return;navigateTo(parentPath(p));}' +
  'function allVisibleSelected(files,base){if(!files.length)return false;for(var i=0;i<files.length;i++){var fp=base?(base+"/"+files[i].name):files[i].name;if(!selectedItems[fp])return false;}return true;}' +
  'function selectedPayload(){return selectedList().map(function(x){return {path:x.fp,isDir:x.isDir};});}' +
  'function itemParent(fp){var parts=(fp||"").split("/").filter(Boolean);parts.pop();return parts.join("/");}' +
  'function setSmartVisible(el,on,display){if(el)el.style.display=on?display:"none";}' +
  'function updateSmartToolbar(kind){' +
  '  var isFiles=kind==="files",isDashboard=kind==="dashboard";' +
  '  var toolbar=document.querySelector(".desktop-toolbar"),back=document.getElementById("go-back-btn"),bc=document.getElementById("breadcrumb"),search=document.getElementById("toolbar-search-wrap"),viewList=document.getElementById("toolbar-view-list"),viewGrid=document.getElementById("toolbar-view-grid"),theme=document.getElementById("toolbar-theme"),upload=document.getElementById("toolbar-upload");' +
  '  var hasParent=isFiles&&!!(currentPath||"");' +
  '  setSmartVisible(back,hasParent,"flex");' +
  '  setSmartVisible(bc,!isDashboard,"flex");' +
  '  setSmartVisible(search,false,"block");' +
  '  setSmartVisible(viewList,isFiles,"flex");' +
  '  setSmartVisible(viewGrid,isFiles,"flex");' +
  '  setSmartVisible(upload,isFiles,"inline-flex");' +
  '  setSmartVisible(theme,true,"inline-flex");' +
  '  if(toolbar)toolbar.style.justifyContent=isDashboard?"flex-end":"flex-start";' +
  '}' +
  'function setSectionChrome(kind){var a=document.querySelector(".mobile-actions");if(a)a.style.display=kind==="files"?"flex":"none";updateSmartToolbar(kind);if(kind!=="files"){try{clearTimeout(searchTimer);var s=document.getElementById("search-inp");if(s)s.value="";}catch(e){}}}' +
  'function moveItemTo(from,name,dest){dest=dest||"";if(!from||dest===from||dest.indexOf(from+"/")===0)return;var to=dest?(dest+"/"+name):name;if(to===from)return;fetch("/api/fm/move",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({from:from,to:to})}).then(function(r){return r.json();}).then(function(d){if(d.ok)navigateTo(activePath());else alert(d.error||"Ошибка перемещения");});}' +
  'function moveMultiTo(items,dest){dest=dest||"";var valid=items.filter(function(item){if(!item.fp||item.fp===dest)return false;if(dest&&dest.indexOf(item.fp+"/")===0)return false;return true;});if(!valid.length)return;var promises=valid.map(function(item){var to=dest?(dest+"/"+item.name):item.name;if(to===item.fp)return Promise.resolve({ok:true});return fetch("/api/fm/move",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({from:item.fp,to:to})}).then(function(r){return r.json();});});Promise.all(promises).then(function(results){var errs=results.filter(function(d){return!d.ok;});clearSelection();navigateTo(activePath());if(errs.length)alert(errs.length+" файл(ов) не удалось переместить");});}' +
  'function fileEmojiDrag(name,isDir){if(isDir)return"📁";var e=(name||"").split(".").pop().toLowerCase();return{mp4:"🎬",mkv:"🎬",avi:"🎬",mov:"🎬",webm:"🎬",mp3:"🎵",flac:"🎵",wav:"🎵",zip:"📦",rar:"📦","7z":"📦",tar:"📦",gz:"📦",exe:"💿",msi:"💿",iso:"💿",pdf:"📄",jpg:"🖼",jpeg:"🖼",png:"🖼",gif:"🖼",webp:"🖼"}[e]||"📄";}' +
  'function createDragGhost(e,items){removeDragGhost();var count=items.length;var first=items[0];var cs=getComputedStyle(document.documentElement);var surfCont=cs.getPropertyValue("--surf-cont").trim()||"#1b1b1f";var onSurf=cs.getPropertyValue("--on-surf").trim()||"#e4e1e7";var accentRaw=cs.getPropertyValue("--accent-color").trim()||"120 80 255";var accent="rgb("+accentRaw+")";var numBg=Math.min(count-1,2);var w=180,cardH=48;var ghost=document.createElement("div");ghost.style.cssText="position:fixed;top:-600px;left:-600px;pointer-events:none;z-index:9999;width:"+(w+numBg*8)+"px;height:"+(cardH+numBg*8)+"px;overflow:visible";for(var i=numBg;i>0;i--){var bg=document.createElement("div");var off=(numBg-i+1)*6;var rot=(numBg-i+1)*2.5;bg.style.cssText="position:absolute;left:"+off+"px;top:"+off+"px;width:"+w+"px;height:"+cardH+"px;background:"+surfCont+";border-radius:13px;transform:rotate("+rot+"deg);box-shadow:0 4px 16px rgba(0,0,0,.45);border:1.5px solid rgba(255,255,255,.07);opacity:.62";ghost.appendChild(bg);}var front=document.createElement("div");front.style.cssText="position:absolute;left:0;top:0;width:"+w+"px;height:"+cardH+"px;background:"+surfCont+";border-radius:13px;display:flex;align-items:center;gap:8px;padding:0 12px;box-shadow:0 8px 30px rgba(0,0,0,.55);border:1.5px solid rgba(255,255,255,.13);overflow:hidden";var ico=document.createElement("span");ico.style.cssText="font-size:20px;flex-shrink:0;line-height:1";ico.textContent=fileEmojiDrag(first.name,first.isDir);var nm=document.createElement("span");nm.style.cssText="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;font-size:12px;font-weight:700;color:"+onSurf+";font-family:Manrope,system-ui,sans-serif";nm.textContent=first.name.length>22?first.name.slice(0,20)+"…":first.name;front.appendChild(ico);front.appendChild(nm);if(count>1){var badge=document.createElement("div");badge.style.cssText="position:absolute;top:-8px;right:-8px;background:"+accent+";color:#fff;border-radius:9999px;font-size:11px;font-weight:800;min-width:20px;height:20px;display:flex;align-items:center;justify-content:center;padding:0 4px;box-shadow:0 2px 8px rgba(0,0,0,.5);font-family:Manrope,system-ui,sans-serif";badge.textContent=count;front.appendChild(badge);}ghost.appendChild(front);document.body.appendChild(ghost);dragGhostEl=ghost;e.dataTransfer.setDragImage(ghost,24,cardH/2);}' +
  'function removeDragGhost(){if(dragGhostEl){try{document.body.removeChild(dragGhostEl);}catch(ex){}dragGhostEl=null;}}' +
  'function showToast(title,body,url){title=title||"";body=body||"";toastUrl=url||"";if(!title&&!body&&!url)return hideToast();document.getElementById("toast-title").textContent=title;document.getElementById("toast-body").textContent=body||url||"";var actions=document.getElementById("toast-share-actions");if(actions){actions.style.display=url?"flex":"none";}document.getElementById("toast").style.display="flex";if(url&&navigator.clipboard)navigator.clipboard.writeText(url).catch(function(){});}' +
  'function hideToast(){document.getElementById("toast").style.display="none";}' +
  'function copyToast(){if(toastUrl&&navigator.clipboard)navigator.clipboard.writeText(toastUrl).then(function(){showToast("Скопировано",toastUrl,toastUrl);});}' +
  'function qrImageUrl(url){return "/api/qr?data="+encodeURIComponent(url);}' +
  'function openQrModal(url){var full=url||toastUrl;if(!full)return;toastUrl=full;document.getElementById("qr-link-text").textContent=full;document.getElementById("qr-img").src=qrImageUrl(full);document.getElementById("qr-open-link").href=full;document.getElementById("modal-qr").style.display="flex";}' +
  'function closeQrModal(){document.getElementById("modal-qr").style.display="none";document.getElementById("qr-img").removeAttribute("src");}' +
  'function copyOrShowLink(url){var full=window.location.origin+url;showToast("Публичная ссылка готова",full,full);}' +
  'function playDoneSound(){try{var ac=new (window.AudioContext||window.webkitAudioContext)();var o=ac.createOscillator(),g=ac.createGain();o.type="sine";o.frequency.setValueAtTime(660,ac.currentTime);o.frequency.setValueAtTime(880,ac.currentTime+.12);g.gain.setValueAtTime(.0001,ac.currentTime);g.gain.exponentialRampToValueAtTime(.08,ac.currentTime+.02);g.gain.exponentialRampToValueAtTime(.0001,ac.currentTime+.34);o.connect(g);g.connect(ac.destination);o.start();o.stop(ac.currentTime+.36);}catch(e){}}' +
  'function notifyDone(name){playDoneSound();showToast("Загрузка завершена",name||"Файл готов","");if("Notification" in window){if(Notification.permission==="granted")new Notification("CloudSpace: загрузка завершена",{body:name||"Файл готов"});else if(Notification.permission==="default")Notification.requestPermission().then(function(p){if(p==="granted")new Notification("CloudSpace: загрузка завершена",{body:name||"Файл готов"});});}}' +
  'function notifyFail(name,error){showToast("Загрузка не удалась",(name||"Media download")+(error?": "+error:""),"");if("Notification" in window){if(Notification.permission==="granted")new Notification("CloudSpace: загрузка не удалась",{body:(name||"Media download")+(error?": "+error:"")});else if(Notification.permission==="default")Notification.requestPermission().then(function(p){if(p==="granted")new Notification("CloudSpace: загрузка не удалась",{body:(name||"Media download")+(error?": "+error:"")});});}}' +
  'var connectionOnline=true,connectionHadDrop=false,connectionTimer=null;' +
  'function setConnectionState(ok,checking){var pill=document.getElementById("connection-pill"),txt=document.getElementById("connection-text");if(!pill||!txt)return;clearTimeout(connectionTimer);pill.classList.remove("offline","checking");if(ok){connectionOnline=true;if(connectionHadDrop){showToast("\\u0421\\u043e\\u0435\\u0434\\u0438\\u043d\\u0435\\u043d\\u0438\\u0435 \\u0432\\u043e\\u0441\\u0441\\u0442\\u0430\\u043d\\u043e\\u0432\\u043b\\u0435\\u043d\\u043e","CloudSpace \\u0441\\u043d\\u043e\\u0432\\u0430 \\u043d\\u0430 \\u0441\\u0432\\u044f\\u0437\\u0438","");connectionHadDrop=false;}pill.style.display="none";return;}connectionOnline=false;connectionHadDrop=true;txt.textContent=checking?"\\u041f\\u0440\\u043e\\u0432\\u0435\\u0440\\u044f\\u044e \\u0441\\u043e\\u0435\\u0434\\u0438\\u043d\\u0435\\u043d\\u0438\\u0435...":"\\u041d\\u0435\\u0442 \\u0441\\u0432\\u044f\\u0437\\u0438 \\u0441 VPS";pill.classList.add(checking?"checking":"offline");pill.style.display="flex";}' +
  'async function checkConnection(silent){if(!navigator.onLine){setConnectionState(false,false);return;}try{if(!silent)setConnectionState(false,true);var c=new AbortController();var tm=setTimeout(function(){c.abort();},4500);var r=await fetch("/api/speedtest/ping?health=1&x="+Date.now(),{cache:"no-store",signal:c.signal});clearTimeout(tm);setConnectionState(!!r.ok,false);}catch(e){setConnectionState(false,false);}}' +
  'window.addEventListener("offline",function(){setConnectionState(false,false);});' +
  'window.addEventListener("online",function(){checkConnection(false);});' +
  'function rememberNewFile(job){if(!job||!job.file)return;var ts=new Date(job.updatedAt||job.createdAt||Date.now()).getTime();if(Date.now()-ts>30*60*1000)return;var fp=(job.folder?job.folder+"/":"")+job.file;recentNewFiles[fp]=ts+30*60*1000;}' +
  'function savePendingUrlJobs(){try{localStorage.setItem("pending-url-jobs",JSON.stringify(pendingUrlJobs));}catch(e){}}' +
  'function markPendingUrlJob(gid,folder){if(!gid)return;pendingUrlJobs[gid]={folder:folder||"",at:Date.now(),seen:false};savePendingUrlJobs();}' +
  'function clearPendingUrlJob(gid){if(!gid||!pendingUrlJobs[gid])return;delete pendingUrlJobs[gid];savePendingUrlJobs();}' +
  'function isNewFile(fp){var until=recentNewFiles[fp]||0;if(until<Date.now()){delete recentNewFiles[fp];return false;}return true;}' +
  'function setTransfersUi(count){var card=document.getElementById("transfers-card"),chip=document.getElementById("transfers-chip"),txt=document.getElementById("transfers-chip-text");if(!card||!chip)return;if(count>0){txt.textContent=count+" активн.";if(transfersMinimized){card.style.display="none";chip.classList.add("active");}else{card.style.display="block";chip.classList.remove("active");}}else{card.style.display="none";chip.classList.remove("active");}}' +
  'function applyTheme(){var light=localStorage.getItem("fm-theme")==="light";document.body.classList.toggle("light",light);applyAccentColor();}' +
  'function toggleTheme(){localStorage.setItem("fm-theme",document.body.classList.contains("light")?"dark":"light");applyTheme();}' +
  'function fileKind(name){var ext=(name.split(".").pop()||"").toLowerCase();if(["png","jpg","jpeg","gif","webp","svg","bmp"].includes(ext))return"image";if(["mp4","webm","ogg","mov","mkv"].includes(ext))return"video";if(["mp3","wav","m4a","flac","aac","oga"].includes(ext))return"audio";if(ext==="pdf")return"pdf";if(["docx","xlsx","xls","ods","csv"].includes(ext))return"office";if(["zip","rar","7z","tar","gz"].includes(ext))return"archive";if(["exe","msi","apk","deb"].includes(ext))return"app";if(["txt","log","md","json","js","css","html","xml","yml","yaml","ini","conf"].includes(ext))return"text";return"file";}' +
  'function fileThumb(name,fp,isDir){if(isDir)return \'<div class="file-thumb"><span class="material-symbols-outlined">folder</span></div>\';var k=fileKind(name);var ext=(name.split(".").pop()||"").toLowerCase();if(k==="image"||ext==="exe"||k==="video"){var fb=ext==="exe"?"deployed_code":k==="video"?"movie":"image";return \'<div class="file-thumb"><img src="/api/fm/preview?path=\'+encodeURIComponent(fp)+\'&thumb=1" onerror="this.outerHTML=\'+String.fromCharCode(39)+\'<span class=material-symbols-outlined>\'+fb+\'</span>\'+String.fromCharCode(39)+\'"></div>\';}var icons={video:"movie",audio:"audio_file",pdf:"picture_as_pdf",office:"table_view",archive:"folder_zip",app:"deployed_code",text:"article",file:"draft"};return \'<div class="file-thumb"><span class="material-symbols-outlined">\'+(icons[k]||"draft")+\'</span></div>\';}' +
  'function makeZip(items,name,startDownload){return fetch("/api/fm/zip",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({items:items,name:name||"cloudspace.zip"})}).then(function(r){return r.json();}).then(function(d){if(!d.ok)throw new Error(d.error||"Ошибка архива");if(startDownload)window.location.href=d.url;return d;});}' +
  'function downloadSelected(){var items=selectedList();if(!items.length)return;if(items.some(function(x){return x.isDir;})||items.length>5){zipSelected();return;}items.forEach(function(it,i){setTimeout(function(){var a=document.createElement("a");a.href="/api/fm/download?path="+encodeURIComponent(it.fp);a.download=it.name;document.body.appendChild(a);a.click();a.remove();},i*350);});}' +
  'function zipSelected(){var items=selectedPayload();if(!items.length)return;makeZip(items,"cloudspace.zip",true).catch(function(e){alert(e.message);});}' +
  'function openShareModal(payload,label){pendingShare=payload;document.getElementById("share-target-label").textContent=label||"Настройки доступа";document.getElementById("share-expire-inp").value="0";document.getElementById("share-max-inp").value="";document.getElementById("share-password-inp").value="";document.getElementById("share-preview-chk").checked=true;document.getElementById("share-status").textContent="";document.getElementById("modal-share").style.display="flex";}' +
  'function closeShareModal(){document.getElementById("modal-share").style.display="none";pendingShare=null;}' +
  'function confirmShare(){if(!pendingShare)return;var body=Object.assign({},pendingShare);body.expiresIn=parseInt(document.getElementById("share-expire-inp").value||"0",10);body.maxDownloads=parseInt(document.getElementById("share-max-inp").value||"0",10);body.password=document.getElementById("share-password-inp").value.trim();body.preview=document.getElementById("share-preview-chk").checked;var st=document.getElementById("share-status");st.textContent="Создаю ссылку...";fetch("/api/fm/share",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json();}).then(function(d){if(d.ok){closeShareModal();copyOrShowLink(d.url);if(previewFp)renderPreviewInfo(previewFp,previewName);}else st.textContent=d.error||"Ошибка ссылки";}).catch(function(){st.textContent="Ошибка ссылки";});}' +
  'function shareSelected(){var items=selectedPayload();if(!items.length)return;openShareModal({items:items},"Выбрано объектов: "+items.length);}' +
  'function shareOne(fp){openShareModal({path:fp},"Объект: "+fp);}' +
  'function shareExpireOptions(selected){var opts=[[0,"Без ограничения"],[1,"1 час"],[24,"1 день"],[72,"3 дня"],[168,"7 дней"],[720,"30 дней"]];return opts.map(function(o){return "<option value=\\""+o[0]+"\\""+(String(selected)===String(o[0])?" selected":"")+">"+o[1]+"</option>";}).join("");}' +
  'function shareDateText(v){return v?fmtDateTime(v):"Без ограничения";}' +
  'function shareMaxText(v){return v?String(v):"Без лимита";}' +
  'function openShareManager(fp,name){shareManagerFp=fp;shareManagerName=name||fp;document.getElementById("sm-file-label").textContent=shareManagerName+" · "+shareManagerFp;document.getElementById("sm-status").textContent="";document.getElementById("sm-new-password").value="";document.getElementById("modal-share-manager").style.display="flex";loadShareManager();}' +
  'function closeShareManager(){document.getElementById("modal-share-manager").style.display="none";shareManagerFp="";shareManagerName="";}' +
  'function renderShareManager(items){var box=document.getElementById("sm-list");if(!items.length){box.innerHTML=\'<div class="card" style="padding:14px;margin:0;color:#958ea0">У этого файла пока нет публичных ссылок.</div>\';return;}var h="";items.forEach(function(x){var full=window.location.origin+x.url;var lockIcon=x.hasPassword?"\u{1F512}":"\u{1F513}";h+=\'<div class="card" style="padding:14px;margin:0 0 10px 0"><div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:10px"><div style="flex:1;min-width:0"><div style="font-size:12px;color:#958ea0;margin-bottom:4px">Создана: \'+H(fmtDateTime(x.created))+\'; действует до: \'+H(shareDateText(x.expiresAt))+\' &middot; \'+lockIcon+\'</div><div style="font-size:12px;color:#d2bbff;word-break:break-all">\'+H(full)+\'</div><div style="font-size:12px;color:#958ea0;margin-top:4px">Скачиваний: \'+H(String(x.downloads||0))+\' / \'+H(shareMaxText(x.maxDownloads))+\'</div></div><button class="btn-ghost" data-action="sm-qr" data-url="\'+H(full)+\'" style="padding:6px 9px"><span class="material-symbols-outlined">qr_code_2</span></button><button class="btn-ghost" data-action="sm-copy" data-url="\'+H(full)+\'" style="padding:6px 9px"><span class="material-symbols-outlined">content_copy</span></button></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px"><select id="sm-expire-\'+H(x.token)+\'" class="inp">\'+shareExpireOptions(0)+\'</select><input id="sm-max-\'+H(x.token)+\'" class="inp" type="number" min="0" step="1" value="\'+H(x.maxDownloads||"")+\'" placeholder="0 = без лимита"></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px"><input id="sm-password-\'+H(x.token)+\'" class="inp" type="password" placeholder="Новый пароль"><label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#958ea0;cursor:pointer"><input type="checkbox" id="sm-clear-password-\'+H(x.token)+\'"> Сбросить пароль</label></div><label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#958ea0;margin-bottom:10px"><input type="checkbox" id="sm-preview-\'+H(x.token)+\'" \'+(x.preview!==false?"checked":"")+\' > Страница предпросмотра</label><div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn-ghost" data-action="sm-save" data-token="\'+H(x.token)+\'">Сохранить</button><button class="btn-ghost" data-action="sm-revoke" data-token="\'+H(x.token)+\'" style="color:#ffb4ab;border-color:#93000a">Отозвать</button></div></div>\';});box.innerHTML=h;}' +
  'function loadShareManager(){if(!shareManagerFp)return;document.getElementById("sm-status").textContent="Загружаю ссылки...";fetch("/api/fm/shares?path="+encodeURIComponent(shareManagerFp)).then(function(r){return r.json();}).then(function(d){if(!d.ok){document.getElementById("sm-status").textContent=d.error||"Ошибка";return;}document.getElementById("sm-status").textContent="";renderShareManager(d.shares||[]);}).catch(function(){document.getElementById("sm-status").textContent="Ошибка загрузки ссылок";});}' +
  'function createManagedShare(){if(!shareManagerFp)return;var body={path:shareManagerFp,expiresIn:parseInt(document.getElementById("sm-new-expire").value||"0",10),maxDownloads:parseInt(document.getElementById("sm-new-max").value||"0",10),password:document.getElementById("sm-new-password").value.trim(),preview:document.getElementById("sm-new-preview").checked};document.getElementById("sm-status").textContent="Создаю ссылку...";fetch("/api/fm/share",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json();}).then(function(d){if(d.ok){document.getElementById("sm-new-expire").value="0";document.getElementById("sm-new-max").value="";document.getElementById("sm-new-password").value="";document.getElementById("sm-new-preview").checked=true;copyOrShowLink(d.url);loadShareManager();if(previewFp===shareManagerFp)renderPreviewInfo(previewFp,previewName);}else document.getElementById("sm-status").textContent=d.error||"Ошибка ссылки";}).catch(function(){document.getElementById("sm-status").textContent="Ошибка ссылки";});}' +
  'function saveManagedShare(token){var clearChecked=!!(document.getElementById("sm-clear-password-"+token)||{}).checked;var passVal=(document.getElementById("sm-password-"+token)||{}).value||"";var body={expiresIn:parseInt((document.getElementById("sm-expire-"+token)||{}).value||"0",10),maxDownloads:parseInt((document.getElementById("sm-max-"+token)||{}).value||"0",10),preview:!!(document.getElementById("sm-preview-"+token)||{}).checked};if(clearChecked)body.password="";else if(passVal.trim())body.password=passVal.trim();document.getElementById("sm-status").textContent="Сохраняю...";fetch("/api/fm/share/"+encodeURIComponent(token),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json();}).then(function(d){document.getElementById("sm-status").textContent=d.ok?"Сохранено":(d.error||"Ошибка");loadShareManager();if(previewFp===shareManagerFp)renderPreviewInfo(previewFp,previewName);}).catch(function(){document.getElementById("sm-status").textContent="Ошибка сохранения";});}' +
  'function revokeManagedShare(token){if(!confirm("Отозвать эту публичную ссылку?"))return;fetch("/api/share/"+encodeURIComponent(token),{method:"DELETE"}).then(function(r){return r.json();}).then(function(d){if(!d.ok)throw new Error(d.error||"Ошибка");loadShareManager();if(previewFp===shareManagerFp)renderPreviewInfo(previewFp,previewName);}).catch(function(e){document.getElementById("sm-status").textContent=e.message;});}' +
  'function copyPlain(url){if(navigator.clipboard)navigator.clipboard.writeText(url).then(function(){showToast("Скопировано",url,url);});}' +
  /* ── BREADCRUMB ── */
  'function renderBreadcrumb(p){' +
  '  var el=document.getElementById("breadcrumb");' +
  '  var parts=p?p.split("/").filter(Boolean):[];' +
  '  var back=document.getElementById("go-back-btn");if(back)back.dataset.dropPath=parentPath(p);' +
  '  var html=\'<span data-action="navigate" data-drop-path="" data-fp="" style="color:var(--accent-color);cursor:pointer;font-weight:600">Мои файлы</span>\';' +
  '  var built="";' +
  '  for(var i=0;i<parts.length;i++){' +
  '    built=built?(built+"/"+parts[i]):parts[i];' +
  '    html+=\'<span class="breadcrumb-sep">/</span>\';' +
  '    html+=\'<span data-action="navigate" data-drop-path="\'+H(built)+\'" data-fp="\'+H(built)+\'" style="cursor:pointer;color:#cbc3d7">\'+H(parts[i])+"</span>";' +
  '  }' +
  '  el.innerHTML=html;' +
  '}' +
  /* ── NAVIGATE & LOAD ── */
  'function navigateTo(p){' +
  '  p=p||"";' +
  '  var s=document.getElementById("search-inp");if(s)s.value="";' +
  '  activeFilter="all";' +
  '  if(p!==currentPath)clearSelection(false);' +
  '  currentPath=p;' +
  '  savePath(p);' +
  '  loadDir();' +
  '}' +
  'function loadDir(){' +
  '  setSectionChrome("files");' +
  '  setNavActive("nav-files");' +
  '  renderBreadcrumb(currentPath);' +
  '  document.getElementById("file-area").innerHTML=\'<div style="color:#958ea0;padding:40px;text-align:center">Загрузка...</div>\';' +
  '  fetch("/api/fm/list?path="+encodeURIComponent(currentPath))' +
  '  .then(function(r){return r.json();})' +
  '  .then(function(d){' +
  '    if(d.error){document.getElementById("file-area").innerHTML=\'<div style="color:#ffb4ab;padding:24px">\'+H(d.error)+"</div>";return;}' +
  '    renderContent(d.entries||[]);' +
  '  })' +
  '  .catch(function(){document.getElementById("file-area").innerHTML=\'<div style="color:#ffb4ab;padding:24px">Ошибка загрузки</div>\';});' +
  '}' +
  "function loadDashboard(){" +
  "  currentPath=\"__dashboard__\";savePath(\"__dashboard__\");clearSelection(false);setSectionChrome(\"dashboard\");setNavActive(\"nav-dashboard\");" +
  "  var bc=document.getElementById(\"breadcrumb\");if(bc)bc.innerHTML='<span style=\"color:var(--accent-color);font-weight:800\">CloudSpace</span><span class=\"breadcrumb-sep\">/</span><span>Главная</span>';" +
  "  var h='';" +
  "  h+='<section style=\"display:grid;grid-template-columns:minmax(0,1.55fr) minmax(300px,.85fr);gap:18px;align-items:stretch\">';" +
  "  h+='<div style=\"position:relative;overflow:hidden;border:1px solid color-mix(in srgb,var(--accent-color) 46%,transparent);border-radius:24px;padding:28px;background:radial-gradient(circle at 12% 0%,var(--accent-bg),transparent 34%),linear-gradient(135deg,#211934 0%,#141416 58%,#101114 100%);min-height:290px;box-shadow:0 24px 80px rgba(0,0,0,.32)\">';" +
  "  h+='<div style=\"display:flex;align-items:center;gap:10px;margin-bottom:20px;color:#d7c7ff;font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:.08em\"><span class=\"material-symbols-outlined\">bolt</span> Быстрая отправка на VPS</div>';" +
  "  h+='<h1 style=\"font-size:34px;line-height:1.08;margin:0 0 10px;color:#fff;font-weight:900;max-width:760px\">Скачай файл на сервер и забери с любого устройства</h1>';" +
  "  h+='<div style=\"color:#bfb5d6;font-size:14px;line-height:1.55;max-width:780px;margin-bottom:22px\">Вставь ссылку, выбери режим или закинь файл с компьютера. Всё попадёт в CloudSpace, без прыжков между вкладками.</div>';" +
"  h+='<div style=\"display:flex;justify-content:space-between;align-items:center;margin-bottom:8px\">';" +
  "  h+='  <div style=\"font-size:11px;font-weight:600;color:var(--on-surf-var);text-transform:uppercase;letter-spacing:.8px\">Ссылка для загрузки</div>';" +
  "  h+='  <button class=\"btn-ghost\" id=\"dash-url-toggle-batch\" onclick=\"toggleDashUrlBatchMode()\" style=\"padding:4px 8px;font-size:11px;border-radius:8px;min-height:24px;color:var(--accent-light);border-color:transparent\">Несколько ссылок</button>';" +
  "  h+='</div>';" +
  "  h+='<div style=\"display:grid;grid-template-columns:minmax(0,1fr) 170px;gap:10px;margin-bottom:10px\">';" +
  "  h+='<div style=\"position:relative;width:100%\">';" +
  "  h+='<input id=\"dash-url-inp\" class=\"inp\" placeholder=\"https://example.com/file.zip или ссылка на видео\" style=\"width:100%;box-sizing:border-box;margin:0\">';" +
  "  h+='<textarea id=\"dash-url-inp-batch\" style=\"display:none;width:100%;height:100px;border-radius:14px;border:1.5px solid var(--outline-var);padding:10px 14px;background:var(--surf-hi);color:var(--on-surf);font-size:13px;font-family:monospace;resize:none;outline:none;box-sizing:border-box;transition:border-color .2s,box-shadow .2s;margin:0\" placeholder=\"Вставьте одну или несколько ссылок, каждую с новой строки...\" onfocus=\"this.style.borderColor=\\'var(--accent-color)\\';this.style.boxShadow=\\'0 0 0 3px color-mix(in srgb,var(--accent-color) 18%,transparent)\\'\" onblur=\"this.style.borderColor=\\'var(--outline-var)\\';this.style.boxShadow=\\'none\\'\"></textarea>';" +
  "  h+='</div>';" +
  "  h+='<select id=\"dash-mode-inp\" class=\"inp\"><option value=\"file\">Обычный файл</option><option value=\"video\">Видео</option><option value=\"audio\">MP3 audio</option><option value=\"best\">Лучший файл</option></select></div>';" +
  "  h+='<div id=\"dash-buttons-row\" style=\"display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:10px;align-items:center\"><input id=\"dash-name-inp\" class=\"inp\" placeholder=\"Имя без расширения, если нужно\" style=\"margin:0\"><button class=\"btn-primary\" data-action=\"dashboard-url-download\"><span class=\"material-symbols-outlined\">download</span> Загрузить</button><button id=\"dash-upload-btn\" class=\"btn-ghost\" data-action=\"upload-btn\"><span class=\"material-symbols-outlined\">upload_file</span> С ПК</button></div>';" +
  "  h+='<div id=\"dash-url-status\" style=\"font-size:12px;color:#8ff0a4;min-height:18px;margin-top:12px\"></div>';" +
  "  h+='</div>';" +
  "  h+='<div style=\"display:grid;grid-template-rows:auto 1fr;gap:18px\">';" +
  "  h+='<div class=\"card\" data-action=\"nav-files\" style=\"margin:0;padding:24px;cursor:pointer;border-radius:28px;background:linear-gradient(145deg,color-mix(in srgb,var(--accent-color) 12%,var(--surf-cont)),var(--surf-cont));min-height:160px;transition:transform .3s var(--m3-spring),box-shadow .3s\"><div style=\"display:flex;align-items:center;justify-content:space-between;gap:12px\"><div style=\"width:48px;height:48px;border-radius:16px;background:color-mix(in srgb,var(--accent-color) 22%,var(--surf-hi));display:flex;align-items:center;justify-content:center\"><span class=\"material-symbols-outlined\" style=\"font-size:28px;color:var(--accent-light);font-variation-settings:chr(39)FILL chr(39) 1,chr(39)wght chr(39) 600,chr(39)GRAD chr(39) 0,chr(39)opsz chr(39) 28\">folder_open</span></div><span class=\"material-symbols-outlined\" style=\"color:var(--outline)\">arrow_forward_ios</span></div><div style=\"font-size:24px;font-weight:800;color:var(--on-surf);margin-top:20px;font-family:var(--font-display);letter-spacing:-.01em\">Мои файлы</div><div id=\"dash-files-meta\" style=\"font-size:13px;color:var(--on-surf-var);margin-top:6px\">Считаю хранилище...</div></div>';" +
  "  h+='<div class=\"card\" style=\"margin:0;padding:24px;border-radius:28px;background:linear-gradient(145deg,color-mix(in srgb,var(--accent-color) 8%,var(--surf-cont)),var(--surf-cont))\"><div style=\"font-size:11px;color:var(--accent-light);font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin-bottom:14px\">Хранилище</div><div style=\"display:flex;align-items:flex-end;justify-content:space-between;gap:12px\"><div id=\"dash-disk-big\" style=\"font-size:32px;font-weight:800;color:var(--on-surf);font-family:var(--font-display);letter-spacing:-.02em\">...</div><div id=\"dash-disk-small\" style=\"font-size:12px;color:var(--on-surf-var);text-align:right\">Загрузка</div></div><div class=\"disk-bar\" style=\"margin-top:16px\"><div class=\"disk-fill\" id=\"dash-disk-fill\" style=\"width:0%\"></div></div></div>';" +
  "  h+='</div>';" +
  "  h+='</section>';" +
  "  h+='<section style=\"display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-top:18px\">';" +
  "  h+=dashActionCard(\"list_alt\",\"Активность\",\"Лог действий с файлами\",\"nav-activity\",\"#ffd166\");" +
  "  h+=dashActionCard(\"settings\",\"Настройки\",\"Пароль, токен, аккаунты\",\"nav-settings\",\"#8ff0a4\");" +
  "  h+=dashActionCard(\"create_new_folder\",\"Новая папка\",\"Сразу перейти в файлы\",\"nav-files\",\"#9ddcff\");" +
  "  h+='</section>';" +
  "  h+='<section style=\"display:grid;grid-template-columns:minmax(0,1fr);gap:18px;margin-top:18px\">';" +
  "  h+='<div class=\"card\" style=\"margin:0;padding:24px;border-radius:28px\"><div style=\"font-size:20px;font-weight:800;color:var(--on-surf);margin-bottom:16px;font-family:var(--font-display);letter-spacing:-.01em\">Сейчас</div><div style=\"display:grid;gap:10px\"><div style=\"display:flex;justify-content:space-between;gap:12px;color:#cbc3d7\"><span>Активные загрузки</span><b id=\"dash-active-count\">0</b></div><div style=\"display:flex;justify-content:space-between;gap:12px;color:#cbc3d7\"><span>Текущий режим</span><b>Cloud</b></div><div style=\"display:flex;justify-content:space-between;gap:12px;color:#cbc3d7\"><span>Версия сайта</span><b style=\"color:var(--accent-light)\">v" + SITE_VERSION + "</b></div></div></div>';" +
  "  h+='</section>';" +
  "  document.getElementById(\"file-area\").innerHTML=h;" +
  "  fetch(\"/api/fm/list?path=\").then(function(r){return r.json();}).then(function(d){" +
  "    var used=d.diskUsed||0,total=d.diskTotal||0,pct=total?Math.min(100,Math.round(used/total*100)):0;" +
  "    var files=(d.entries||[]).filter(function(x){return !x.isDir;}).slice(0,5);" +
  "    var meta=document.getElementById(\"dash-files-meta\");if(meta)meta.textContent=((d.entries||[]).length)+\" объектов · \"+fmtSize(used)+\" / \"+fmtSize(total);" +
  "    var big=document.getElementById(\"dash-disk-big\");if(big)big.textContent=pct+\"%\";" +
  "    var small=document.getElementById(\"dash-disk-small\");if(small)small.textContent=fmtSize(used)+\" занято из \"+fmtSize(total);" +
  "    var fill=document.getElementById(\"dash-disk-fill\");if(fill)fill.style.width=pct+\"%\";" +
  "    var list=document.getElementById(\"dash-recent-list\");if(list)list.innerHTML=files.length?files.map(function(f){var fp=f.name;return '<div data-action=\"preview\" data-fp=\"'+H(fp)+'\" data-name=\"'+H(f.name)+'\" style=\"display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid #2d2936;border-radius:14px;cursor:pointer;background:#161619\">'+fileThumb(f.name,fp,false)+'<div style=\"min-width:0;flex:1\"><div style=\"font-size:13px;font-weight:800;color:#e4e1e6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap\">'+H(f.name)+'</div><div style=\"font-size:11px;color:#958ea0\">'+fmtSize(f.size)+' · '+fmtDate(f.mtime)+'</div></div></div>';}).join(\"\"):'<div style=\"color:#494454;font-size:13px\">Пока нет файлов</div>';" +
  "  }).catch(function(){});" +
  "  fetch(\"/api/downloads\").then(function(r){return r.json();}).then(function(items){var el=document.getElementById(\"dash-active-count\");if(el)el.textContent=Array.isArray(items)?items.length:0;}).catch(function(){});" +
  "}" +
  "function dashActionCard(icon,title,body,action,color){return '<button class=\"card\" data-action=\"'+action+'\" style=\"margin:0;padding:18px;border-radius:20px;text-align:left;cursor:pointer;background:#18181b;color:#e4e1e6;min-height:132px\"><span class=\"material-symbols-outlined\" style=\"font-size:30px;color:'+color+'\">'+icon+'</span><div style=\"font-size:16px;font-weight:900;margin-top:18px\">'+title+'</div><div style=\"font-size:12px;color:#958ea0;margin-top:5px;line-height:1.4\">'+body+'</div></button>';}" +
'function toggleDashUrlBatchMode(){' +
  '  dashUrlBatchMode=!dashUrlBatchMode;' +
  '  var single=document.getElementById("dash-url-inp");' +
  '  var batch=document.getElementById("dash-url-inp-batch");' +
  '  var btn=document.getElementById("dash-url-toggle-batch");' +
  '  var nameInp=document.getElementById("dash-name-inp");' +
  '  var uploadBtn=document.getElementById("dash-upload-btn");' +
  '  var row=document.getElementById("dash-buttons-row");' +
  '  if(dashUrlBatchMode){' +
  '    single.style.display="none";' +
  '    batch.style.display="block";' +
  '    btn.textContent="Одна ссылка";' +
  '    btn.style.color="var(--accent-color)";' +
  '    if(nameInp)nameInp.style.display="none";' +
  '    if(uploadBtn)uploadBtn.style.display="none";' +
  '    if(row)row.style.gridTemplateColumns="1fr auto";' +
  '    setTimeout(function(){batch.focus();},50);' +
  '  }else{' +
  '    single.style.display="block";' +
  '    batch.style.display="none";' +
  '    btn.textContent="Несколько ссылок";' +
  '    btn.style.color="var(--accent-light)";' +
  '    if(nameInp)nameInp.style.display="block";' +
  '    if(uploadBtn)uploadBtn.style.display="block";' +
  '    if(row)row.style.gridTemplateColumns="minmax(0,1fr) auto auto";' +
  '    setTimeout(function(){single.focus();},50);' +
  '  }' +
  '}' +
  'function addDashboardUrlDownload(){' +
  '  var mode=document.getElementById("dash-mode-inp").value;' +
  '  var st=document.getElementById("dash-url-status");' +
  '  var media=mode!=="file";' +
  '  if(window.dashUrlBatchMode){' +
  '    var text=document.getElementById("dash-url-inp-batch").value.trim();' +
  '    if(!text){st.textContent="Вставьте ссылки";return;}' +
  '    var urls=text.split("\\n").map(function(x){return x.trim();}).filter(Boolean);' +
  '    if(!urls.length){st.textContent="Вставьте ссылки";return;}' +
  '    st.textContent="Запускаю " + urls.length + " загрузок...";' +
  '    var promises=urls.map(function(url){' +
  '      return fetch(media?"/api/fm/media":"/api/fm/add-url",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url:url,filename:"",path:"",mode:mode})})' +
  '        .then(function(r){return r.json();})' +
  '        .then(function(d){' +
  '          if(d.ok){' +
  '            var gid=d.gid||(d.job&&d.job.id);' +
  '            if(gid){knownMediaStatuses[gid]="active";markPendingUrlJob(gid,"");}' +
  '          }' +
  '        });' +
  '    });' +
  '    Promise.all(promises).then(function(){' +
  '      st.textContent="Все загрузки запущены!";' +
  '      document.getElementById("dash-url-inp-batch").value="";' +
  '      loadTransfers();' +
  '      setTimeout(function(){st.textContent="";if(window.dashUrlBatchMode){toggleDashUrlBatchMode();}},1500);' +
  '    }).catch(function(){' +
  '      st.textContent="Ошибка при пакетной отправке";' +
  '    });' +
  '  }else{' +
  '    var url=document.getElementById("dash-url-inp").value.trim();' +
  '    var name=document.getElementById("dash-name-inp").value.trim();' +
  '    if(!url){st.textContent="Вставь URL";return;}' +
  '    if(media)name=stripInputMediaExt(name);' +
  '    st.textContent=media?"Запускаю медиа-загрузку...":"Добавляю загрузку...";' +
  '    fetch(media?"/api/fm/media":"/api/fm/add-url",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url:url,filename:name,path:"",mode:mode})})' +
  '    .then(function(r){return r.json();}).then(function(d){' +
  '      if(d.ok){' +
  '        var gid=d.gid||(d.job&&d.job.id);' +
  '        if(gid){knownMediaStatuses[gid]="active";markPendingUrlJob(gid,"");}' +
  '        document.getElementById("dash-url-inp").value="";' +
  '        document.getElementById("dash-name-inp").value="";' +
  '        st.textContent="Загрузка запущена";' +
  '        loadTransfers();' +
  '      }else st.textContent=d.error||"Ошибка";' +
  '    }).catch(function(){st.textContent="Ошибка";});' +
  '  }' +
  '}' +
  'function settingsCard(title,body){return \'<div class="card" style="margin:0;padding:18px">\'+\'<div style="font-size:15px;font-weight:800;margin-bottom:12px;color:#e4e1e6">\'+title+\'</div>\'+body+"</div>";}' +
  'function setCloudStatus(id,msg,ok){var el=document.getElementById(id);if(!el)return;el.textContent=msg||"";el.style.color=ok?"#8ff0a4":"#ffb4ab";}' +
  'function fmtMbps(bytes,ms){if(!ms)return "\\u2014";return ((bytes*8)/(ms/1000)/1000000).toFixed(2)+" Mbps";}' +
  'function setSpeedStatus(msg,ok){var el=document.getElementById("speed-status");if(!el)return;el.textContent=msg||"";el.style.color=ok?"#8ff0a4":"#958ea0";}' +
  'async function runSpeedTest(){var st=document.getElementById("speed-status"),p=document.getElementById("speed-ping"),d=document.getElementById("speed-down"),u=document.getElementById("speed-up");if(!st||!p||!d||!u)return;p.textContent=d.textContent=u.textContent="...";setSpeedStatus("\\u041f\\u0440\\u043e\\u0432\\u0435\\u0440\\u044f\\u044e \\u0437\\u0430\\u0434\\u0435\\u0440\\u0436\\u043a\\u0443...",false);try{var pingTimes=[];for(var i=0;i<4;i++){var t0=performance.now();await fetch("/api/speedtest/ping?x="+Date.now()+"-"+i,{cache:"no-store"});pingTimes.push(performance.now()-t0);}var ping=Math.round(pingTimes.reduce(function(a,b){return a+b;},0)/pingTimes.length);p.textContent=ping+" ms";setSpeedStatus("\\u041f\\u0440\\u043e\\u0432\\u0435\\u0440\\u044f\\u044e \\u0441\\u043a\\u0430\\u0447\\u0438\\u0432\\u0430\\u043d\\u0438\\u0435...",false);var size=10*1024*1024,t1=performance.now();var r=await fetch("/api/speedtest/download?size="+size+"&x="+Date.now(),{cache:"no-store"});var buf=await r.arrayBuffer();var downMs=performance.now()-t1;d.textContent=fmtMbps(buf.byteLength,downMs);setSpeedStatus("\\u041f\\u0440\\u043e\\u0432\\u0435\\u0440\\u044f\\u044e \\u0432\\u044b\\u0433\\u0440\\u0443\\u0437\\u043a\\u0443...",false);var upSize=4*1024*1024,payload=new Uint8Array(upSize);for(var j=0;j<upSize;j+=4096)payload[j]=j%251;var t2=performance.now();await fetch("/api/speedtest/upload?x="+Date.now(),{method:"POST",headers:{"Content-Type":"application/octet-stream"},body:payload,cache:"no-store"});var upMs=performance.now()-t2;u.textContent=fmtMbps(upSize,upMs);setSpeedStatus("\\u0413\\u043e\\u0442\\u043e\\u0432\\u043e",true);}catch(e){setSpeedStatus("\\u041d\\u0435 \\u0443\\u0434\\u0430\\u043b\\u043e\\u0441\\u044c \\u0432\\u044b\\u043f\\u043e\\u043b\\u043d\\u0438\\u0442\\u044c \\u0442\\u0435\\u0441\\u0442",false);if(p.textContent==="...")p.textContent="\\u2014";if(d.textContent==="...")d.textContent="\\u2014";if(u.textContent==="...")u.textContent="\\u2014";}}' +
  'function loadCloudSettings(){currentPath="__settings__";savePath("__settings__");clearSelection(false);setSectionChrome("settings");setNavActive("nav-settings");var bc=document.getElementById("breadcrumb");if(bc)bc.innerHTML=\'<span style="color:var(--accent-color);font-weight:800">Настройки</span>\';var html=\'<div class="settings-grid">\';html+=settingsCard(\'Внешний вид\',\'<div class="settings-subtle" style="margin-bottom:14px">Цвет акцента применяется ко всем элементам интерфейса.</div><div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px" id="color-swatches"><button class="color-swatch" data-action="set-accent-hex" data-hex="#a078ff" title="Violet" style="background:#a078ff"></button><button class="color-swatch" data-action="set-accent-hex" data-hex="#10b981" title="Emerald" style="background:#10b981"></button><button class="color-swatch" data-action="set-accent-hex" data-hex="#f43f5e" title="Ruby" style="background:#f43f5e"></button><button class="color-swatch" data-action="set-accent-hex" data-hex="#06b6d4" title="Glacier" style="background:#06b6d4"></button><button class="color-swatch" data-action="set-accent-hex" data-hex="#f59e0b" title="Amber" style="background:#f59e0b"></button><button class="color-swatch" data-action="set-accent-hex" data-hex="#ec4899" title="Pink" style="background:#ec4899"></button><button class="color-swatch" data-action="set-accent-hex" data-hex="#22c55e" title="Green" style="background:#22c55e"></button><button class="color-swatch" data-action="set-accent-hex" data-hex="#6366f1" title="Indigo" style="background:#6366f1"></button><button class="color-swatch" data-action="set-accent-hex" data-hex="#ef4444" title="Red" style="background:#ef4444"></button><button class="color-swatch" data-action="set-accent-hex" data-hex="#14b8a6" title="Teal" style="background:#14b8a6"></button><button class="color-swatch" data-action="set-accent-hex" data-hex="#f97316" title="Orange" style="background:#f97316"></button><button class="color-swatch" data-action="set-accent-hex" data-hex="#a855f7" title="Purple" style="background:#a855f7"></button></div><div style="display:flex;align-items:center;gap:12px;margin-bottom:14px"><span class="settings-subtle" style="white-space:nowrap">Свой цвет</span><input type="color" id="accent-color-input" value="#a078ff" title="Выберите цвет"><span id="accent-hex-label" style="font-size:12px;color:var(--accent-light);font-family:monospace;font-weight:700">#a078ff</span></div><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn-ghost" data-action="toggle-theme"><span class="material-symbols-outlined">contrast</span> Светлая / тёмная</button></div>\');html+=settingsCard(\'Профиль\',\'<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px"><div id="settings-profile-avatar" style="width:48px;height:48px;border-radius:16px;background:var(--accent-gradient);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:900;font-size:18px;flex:0 0 auto">?</div><div style="min-width:0;flex:1"><div id="settings-profile-login" class="settings-subtle" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">@...</div><div id="settings-profile-role" style="font-size:12px;color:var(--accent-light);margin-top:2px;font-weight:800"></div></div></div><div class="settings-subtle" style="margin-bottom:8px">Имя в профиле</div><input id="cloud-profile-label" class="inp" maxlength="40" placeholder="CloudSpace" style="margin-bottom:10px"><button class="btn-primary" data-action="settings-save-profile">Сохранить</button><div id="cloud-profile-status" style="font-size:12px;margin-top:8px;min-height:16px"></div>\');html+=settingsCard(\'Хранение файлов\',\'<div class="settings-subtle" style="margin-bottom:10px">Автоудаление старых файлов</div><select id="cloud-retention" class="inp" style="margin-bottom:10px"><option value="1">1 день</option><option value="3">3 дня</option><option value="7">7 дней</option><option value="30">30 дней</option><option value="0">Никогда</option></select><button class="btn-primary" data-action="settings-save-retention">Сохранить</button><div id="cloud-retention-status" style="font-size:12px;margin-top:8px;min-height:16px"></div>\');html+=settingsCard(\'Уведомления\',\'<div id="cloud-notif-status" class="settings-subtle" style="margin-bottom:10px">Проверяю...</div><button class="btn-ghost" data-action="settings-notif"><span class="material-symbols-outlined">notifications</span> Разрешить уведомления</button>\');html+=settingsCard(\'Speed test\',\'<div class="settings-subtle" style="margin-bottom:10px">Проверка скорости между браузером и VPS</div><button class="btn-primary" data-action="settings-speedtest"><span class="material-symbols-outlined">speed</span> Запустить тест</button><div id="speed-status" class="settings-subtle" style="margin-top:10px;min-height:16px"></div><div id="speed-result" class="speed-result"><div class="speed-metric"><b id="speed-ping">—</b><span>Ping</span></div><div class="speed-metric"><b id="speed-down">—</b><span>Download</span></div><div class="speed-metric"><b id="speed-up">—</b><span>Upload</span></div></div>\');html+=settingsCard(\'Токен расширения\',\'<div id="cloud-token-display" style="font-size:12px;color:var(--accent-light);word-break:break-all;margin-bottom:10px">Скрыт</div><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn-ghost" data-action="settings-load-token">Показать</button><button class="btn-ghost" data-action="settings-copy-token">Копировать</button><button class="btn-ghost" data-action="settings-reset-token" style="color:#ffb4ab;border-color:#93000a">Сбросить</button></div><div id="cloud-token-status" style="font-size:12px;margin-top:8px;min-height:16px"></div>\');html+=settingsCard(\'Telegram\',\'<div id="tg-linked" style="display:none"><div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;padding:10px 12px;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.3);border-radius:10px"><span style="font-size:22px;flex-shrink:0">✅</span><div><div style="font-size:13px;font-weight:700;color:#4ade80">Telegram подключён</div><div id="tg-linked-info" class="settings-subtle" style="margin-top:2px"></div></div></div><button class="btn-ghost" data-action="settings-tg-unlink" style="color:#ffb4ab;border-color:#93000a">Отключить</button></div><div id="tg-unlinked"><div class="settings-subtle" style="margin-bottom:12px">Отправляйте файлы в Telegram — они сохранятся прямо в ваше хранилище на VPS. Поддерживаются документы, фото, видео, аудио.</div><button class="btn-primary" data-action="settings-tg-connect" style="background:linear-gradient(135deg,#0ea5e9,#2563eb)">🤖 Подключить Telegram</button><div class="settings-subtle" style="margin-top:8px">Откроется @SiplyiFolderUpload_bot</div></div><div id="tg-status" style="font-size:12px;margin-top:8px;min-height:16px"></div><hr style="border:none;border-top:1px solid rgba(255,255,255,0.08);margin:14px 0"><div style="font-size:12px;color:#958ea0;margin-bottom:8px">Лимит размера файла через Telegram</div><select id="cloud-tg-limit" class="inp" style="margin-bottom:10px"><option value="5">5 МБ</option><option value="10">10 МБ</option><option value="20">20 МБ</option><option value="50">50 МБ</option><option value="100">100 МБ</option><option value="200">200 МБ</option><option value="500">500 МБ</option><option value="1000">1 ГБ</option><option value="2000">2 ГБ (Максимум)</option></select><button class="btn-primary" data-action="settings-save-tg-limit">Сохранить лимит</button><div id="cloud-tg-limit-status" style="font-size:12px;margin-top:8px;min-height:16px"></div>\');html+=settingsCard(\'Пароль\',\'<input id="cloud-pass-current" class="inp" type="password" placeholder="Текущий пароль" style="margin-bottom:10px"><input id="cloud-pass-new" class="inp" type="password" placeholder="Новый пароль" style="margin-bottom:10px"><button class="btn-primary" data-action="settings-change-password">Сменить пароль</button><div id="cloud-pass-status" style="font-size:12px;margin-top:8px;min-height:16px"></div>\');html+=\'<div id="cloud-users-section" class="card" style="margin:0;padding:18px;display:none"><div class="settings-card-title"><span class="material-symbols-outlined">group</span> Аккаунты</div><div id="cloud-users-list" style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px"></div><div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px"><input id="cloud-new-username" class="inp" placeholder="Логин"><input id="cloud-new-password" class="inp" placeholder="Пароль"><input id="cloud-new-label" class="inp" placeholder="Имя"></div><button class="btn-primary" data-action="settings-add-user">Добавить аккаунт</button><div id="cloud-users-status" style="font-size:12px;margin-top:8px;min-height:16px"></div></div>\';html+="</div>";document.getElementById("file-area").innerHTML=html;applyAccentColor();initColorPicker();loadCloudProfile();loadCloudRetention();updateCloudNotifStatus();loadCloudUsers();loadTelegramStatus();}' +
  'function loadCloudRetention(){fetch("/api/settings").then(function(r){return r.json();}).then(function(d){var el=document.getElementById("cloud-retention");if(el&&d.retention!==undefined)el.value=String(d.retention);var elTg=document.getElementById("cloud-tg-limit");if(elTg&&d.tgLimit!==undefined)elTg.value=String(d.tgLimit);}).catch(function(){});}' +
  'function saveCloudRetention(){var v=document.getElementById("cloud-retention").value;fetch("/api/settings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({retention:parseInt(v,10)})}).then(function(r){return r.json();}).then(function(d){setCloudStatus("cloud-retention-status",d.ok?"Сохранено":(d.error||"Ошибка"),!!d.ok);}).catch(function(){setCloudStatus("cloud-retention-status","Ошибка",false);});}' +
  'function saveCloudTgLimit(){var v=document.getElementById("cloud-tg-limit").value;fetch("/api/settings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tgLimit:parseInt(v,10)})}).then(function(r){return r.json();}).then(function(d){setCloudStatus("cloud-tg-limit-status",d.ok?"Сохранено":(d.error||"Ошибка"),!!d.ok);}).catch(function(){setCloudStatus("cloud-tg-limit-status","Ошибка",false);});}' +
  'function updateCloudNotifStatus(){var el=document.getElementById("cloud-notif-status");if(!el)return;if(!("Notification" in window)){el.textContent="Браузерные уведомления недоступны";return;}el.textContent=Notification.permission==="granted"?"Уведомления включены":Notification.permission==="denied"?"Уведомления запрещены в браузере":"Уведомления еще не разрешены";}' +
  'function requestCloudNotif(){if(!("Notification" in window))return;Notification.requestPermission().then(updateCloudNotifStatus);}' +
  'function loadCloudToken(){fetch("/api/mytoken").then(function(r){return r.json();}).then(function(d){document.getElementById("cloud-token-display").textContent=d.token||"";setCloudStatus("cloud-token-status","Токен загружен",true);}).catch(function(){setCloudStatus("cloud-token-status","Ошибка токена",false);});}' +
  'function loadTelegramStatus(){fetch("/api/tg/status").then(function(r){return r.json();}).then(function(d){var linked=document.getElementById("tg-linked"),unlinked=document.getElementById("tg-unlinked"),info=document.getElementById("tg-linked-info");if(!linked)return;if(d.linked){linked.style.display="";unlinked.style.display="none";if(info)info.textContent=(d.firstName?"@"+d.firstName+" · ":"")+"Подключён "+new Date(d.connectedAt).toLocaleDateString("ru");}else{linked.style.display="none";unlinked.style.display="";}}).catch(function(){});}' +
  'function connectTelegram(){var st=document.getElementById("tg-status");if(st)st.textContent="Открываю бота...";fetch("/api/tg/connect-link").then(function(r){return r.json();}).then(function(d){if(d.url){window.open(d.url,"_blank");if(st)st.textContent="Бот открыт в Telegram. После подтверждения нажмите кнопку ниже.";var btn=document.createElement("button");btn.className="btn-ghost";btn.style.marginTop="8px";btn.textContent="Проверить подключение";btn.onclick=function(){loadTelegramStatus();if(st)st.textContent="";};var stParent=st&&st.parentNode;if(stParent)stParent.insertBefore(btn,st.nextSibling);}else{if(st)st.textContent=d.error||"Ошибка";}}).catch(function(){if(st)st.textContent="Ошибка";});}' +
  'function unlinkTelegram(){if(!confirm("Отключить Telegram?"))return;fetch("/api/tg/unlink",{method:"POST"}).then(function(r){return r.json();}).then(function(){loadTelegramStatus();}).catch(function(){});}' +
  'function initColorPicker(){' +
  '  var inp=document.getElementById("accent-color-input");' +
  '  var lbl=document.getElementById("accent-hex-label");' +
  '  if(!inp)return;' +
  '  var cur=localStorage.getItem("cloud-accent-hex")||"#a078ff";' +
  '  inp.value=cur;if(lbl)lbl.textContent=cur;' +
  '  updateColorSwatches(cur);' +
  '  inp.addEventListener("input",function(){' +
  '    var h=inp.value;localStorage.setItem("cloud-accent-hex",h);' +
  '    if(lbl)lbl.textContent=h;' +
  '    applyAccentColor();updateColorSwatches(h);' +
  '  });' +
  '}' +
  'function updateColorSwatches(hex){' +
  '  var btns=document.querySelectorAll(".color-swatch");' +
  '  btns.forEach(function(b){b.classList.toggle("active",b.dataset.hex&&b.dataset.hex.toLowerCase()===hex.toLowerCase());});' +
  '}' +
  'function copyCloudToken(){var t=(document.getElementById("cloud-token-display")||{}).textContent||"";if(!t||t==="Скрыт"){loadCloudToken();return;}navigator.clipboard&&navigator.clipboard.writeText(t).then(function(){setCloudStatus("cloud-token-status","Скопировано",true);});}' +
  'function resetCloudToken(){if(!confirm("Сбросить токен расширения? Старый перестанет работать."))return;fetch("/api/mytoken/reset",{method:"POST"}).then(function(r){return r.json();}).then(function(d){document.getElementById("cloud-token-display").textContent=d.token||"";setCloudStatus("cloud-token-status","Новый токен готов",true);}).catch(function(){setCloudStatus("cloud-token-status","Ошибка сброса",false);});}' +
  'function updateSidebarProfile(d){var label=d.label||d.username||"",user=d.username||"",role=d.isAdmin?"Admin":"User";var ls=document.getElementById("profile-label-sidebar"),av=document.getElementById("profile-avatar-sidebar"),ms=document.getElementById("profile-meta-sidebar"),sl=document.getElementById("settings-profile-login"),sr=document.getElementById("settings-profile-role"),sa=document.getElementById("settings-profile-avatar");if(ls)ls.textContent=label;if(av)av.textContent=(label||user||"?").trim().charAt(0).toUpperCase()||"?";if(sa)sa.textContent=(label||user||"?").trim().charAt(0).toUpperCase()||"?";if(ms)ms.textContent="@"+user+" \u00b7 "+role;if(sl)sl.textContent="@"+user;if(sr)sr.textContent=role;}\n' +
  'function loadCloudProfile(){fetch("/api/me").then(function(r){return r.json();}).then(function(d){updateSidebarProfile(d);var inp=document.getElementById("cloud-profile-label");if(inp)inp.value=d.label||d.username||"";}).catch(function(){setCloudStatus("cloud-profile-status","\u041e\u0448\u0438\u0431\u043a\u0430 \u043f\u0440\u043e\u0444\u0438\u043b\u044f",false);});}\n' +
  'function saveCloudProfile(){var inp=document.getElementById("cloud-profile-label"),label=(inp&&inp.value||"").trim();fetch("/api/me",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({label:label})}).then(function(r){return r.json().then(function(d){d._ok=r.ok;return d;});}).then(function(d){setCloudStatus("cloud-profile-status",d._ok?"\u0421\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u043e":(d.error||"\u041e\u0448\u0438\u0431\u043a\u0430"),d._ok);if(d._ok)updateSidebarProfile(d);}).catch(function(){setCloudStatus("cloud-profile-status","\u041e\u0448\u0438\u0431\u043a\u0430",false);});}\n' +
  'function changeCloudPassword(){var currentPassword=document.getElementById("cloud-pass-current").value,newPassword=document.getElementById("cloud-pass-new").value;fetch("/api/change-password",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({currentPassword:currentPassword,newPassword:newPassword})}).then(function(r){return r.json().then(function(d){d._ok=r.ok;return d;});}).then(function(d){setCloudStatus("cloud-pass-status",d._ok?"Пароль изменён":(d.error||"Ошибка"),d._ok);if(d._ok){document.getElementById("cloud-pass-current").value="";document.getElementById("cloud-pass-new").value="";}}).catch(function(){setCloudStatus("cloud-pass-status","Ошибка",false);});}' +
  'function loadCloudUsers(){fetch("/api/users").then(function(r){if(!r.ok)throw new Error("not admin");return r.json();}).then(function(users){var sec=document.getElementById("cloud-users-section"),box=document.getElementById("cloud-users-list");if(!sec||!box)return;sec.style.display="block";box.innerHTML=users.map(function(u){return \'<div style="display:flex;align-items:center;gap:8px;border:1px solid #353437;border-radius:12px;padding:8px 10px"><div style="flex:1"><b>\'+H(u.username)+\'</b><div style="font-size:12px;color:#958ea0">\'+H(u.label||"")+\' \'+(u.isAdmin?"· admin":"")+\'</div></div><button class="btn-ghost" data-action="settings-delete-user" data-user="\'+H(u.username)+\'" style="color:#ffb4ab;border-color:#93000a">Удалить</button></div>\';}).join("");}).catch(function(){var sec=document.getElementById("cloud-users-section");if(sec)sec.style.display="none";});}' +
  'function addCloudUser(){var username=document.getElementById("cloud-new-username").value.trim(),password=document.getElementById("cloud-new-password").value,label=document.getElementById("cloud-new-label").value.trim();fetch("/api/users",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:username,password:password,label:label})}).then(function(r){return r.json().then(function(d){d._ok=r.ok;return d;});}).then(function(d){setCloudStatus("cloud-users-status",d._ok?"Аккаунт добавлен":(d.error||"Ошибка"),d._ok);if(d._ok){document.getElementById("cloud-new-username").value="";document.getElementById("cloud-new-password").value="";document.getElementById("cloud-new-label").value="";loadCloudUsers();}}).catch(function(){setCloudStatus("cloud-users-status","Ошибка",false);});}' +
  'function deleteCloudUser(username){if(!confirm("Удалить аккаунт "+username+"?"))return;fetch("/api/users/"+encodeURIComponent(username),{method:"DELETE"}).then(function(r){return r.json().then(function(d){d._ok=r.ok;return d;});}).then(function(d){setCloudStatus("cloud-users-status",d._ok?"Аккаунт удалён":(d.error||"Ошибка"),d._ok);loadCloudUsers();}).catch(function(){setCloudStatus("cloud-users-status","Ошибка",false);});}' +
  'function getFilteredEntries(entries){' +
  '  if(activeFilter==="all")return entries;' +
  '  var map={' +
  '    images:["jpg","jpeg","png","gif","webp","svg","bmp","ico"],' +
  '    videos:["mp4","webm","ogg","mov","mkv"],' +
  '    music:["mp3","wav","m4a","flac","aac","oga"],' +
  '    docs:["pdf","doc","docx","xls","xlsx","ppt","pptx","txt","rtf","odt","ods","odp","csv","md","html","css","js","json","py","sh","yml","yaml"],' +
  '    archives:["zip","rar","tar","gz","7z","bz2","xz"]' +
  '  };' +
  '  var exts=map[activeFilter]||[];' +
  '  return entries.filter(function(e){' +
  '    if(e.isDir)return true;' +
  '    var ext=(e.name.split(".").pop()||"").toLowerCase();' +
  '    return exts.includes(ext);' +
  '  });' +
  '}' +
  'function renderContent(entries,base){' +
  '  lastEntries=entries||[];lastBase=(base!==undefined)?base:currentPath;' +
  '  var filtered=getFilteredEntries(lastEntries);' +
  '  var isFiles=(currentPath!=="__dashboard__"&&currentPath!=="__recent__"&&currentPath!=="__settings__"&&currentPath!=="__activity__");' +
  '  var filterHtml="";' +
  '  if(isFiles){' +
  '    filterHtml=\'<div class="filter-bar" style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;align-items:center;">\' +' +
  '      \'<button class="filter-pill\'+(activeFilter==="all"?" active":"")+\'" data-action="filter-category" data-filter="all">Все</button>\' +' +
  '      \'<button class="filter-pill\'+(activeFilter==="images"?" active":"")+\'" data-action="filter-category" data-filter="images">Изображения</button>\' +' +
  '      \'<button class="filter-pill\'+(activeFilter==="videos"?" active":"")+\'" data-action="filter-category" data-filter="videos">Видео</button>\' +' +
  '      \'<button class="filter-pill\'+(activeFilter==="music"?" active":"")+\'" data-action="filter-category" data-filter="music">Музыка</button>\' +' +
  '      \'<button class="filter-pill\'+(activeFilter==="docs"?" active":"")+\'" data-action="filter-category" data-filter="docs">Документы</button>\' +' +
  '      \'<button class="filter-pill\'+(activeFilter==="archives"?" active":"")+\'" data-action="filter-category" data-filter="archives">Архивы</button>\' +' +
  '    \'</div>\';' +
  '  }' +
  '  document.getElementById("file-area").innerHTML=filterHtml+' +
  '    (currentView==="grid"?fileGridHtml(filtered,lastBase):fileListHtml(filtered,lastBase));' +
  '}' +
  'function fileListHtml(files,base){' +
  '  if(!files.length)return \'<div style="color:#494454;padding:40px;text-align:center">\\u041f\\u0430\\u043f\\u043a\\u0430 \\u043f\\u0443\\u0441\\u0442\\u0430</div>\';' +
  '  var h=\'<div style="background:#1b1b1e;border:1px solid #494454;border-radius:12px;overflow:hidden">\';' +
  '  h+=\'<div class="file-row" style="font-size:12px;font-weight:600;color:#494454;text-transform:uppercase;letter-spacing:.05em;cursor:default;background:#131316"><div style="width:20px"><input class="select-check" type="checkbox" data-action="select-all" \'+(allVisibleSelected(files,base)?"checked":"")+\'></div><div style="width:28px"></div><div style="flex:1">\\u041d\\u0430\\u0437\\u0432\\u0430\\u043d\\u0438\\u0435</div><div style="width:100px;text-align:right">\\u0420\\u0430\\u0437\\u043c\\u0435\\u0440</div><div style="width:130px;text-align:right">\\u0418\\u0437\\u043c\\u0435\\u043d\\u0435\\u043d</div><div style="width:54px"></div></div>\';' +
  '  for(var i=0;i<files.length;i++){var f=files[i],fp=base?(base+"/"+f.name):f.name,checked=!!selectedItems[fp],isNew=isNewFile(fp),badge=isNew?\'<span class="new-badge">New</span>\':"";h+=\'<div class="file-row \'+(checked?"selected ":"")+(isNew?"is-new":"")+\'" draggable="true" data-fp="\'+H(fp)+\'" data-name="\'+H(f.name)+\'" data-dir="\'+f.isDir+\'">\';h+=\'<input class="select-check" type="checkbox" data-action="select-item" data-fp="\'+H(fp)+\'" data-name="\'+H(f.name)+\'" data-dir="\'+f.isDir+\'"\'+(checked?" checked":"")+">";h+=fileThumb(f.name,fp,f.isDir);if(f.isDir)h+=\'<div data-meta="\'+(f.fileCount!=null?H(f.fileCount+" объектов"):"Папка")+\'" style="flex:1;font-weight:500;color:#d0bcff;cursor:pointer;pointer-events:none">\'+H(f.name)+badge+"</div>";else h+=\'<div data-meta="\'+H(fmtSize(f.size)+" · "+fmtDate(f.mtime))+\'" style="flex:1;color:#e4e1e6;pointer-events:none">\'+H(f.name)+badge+"</div>";h+=\'<div style="width:100px;text-align:right;font-size:13px;color:#958ea0;pointer-events:none">\'+(f.isDir?"—":fmtSize(f.size))+"</div>";h+=\'<div style="width:130px;text-align:right;font-size:12px;color:#494454;pointer-events:none">\'+fmtDate(f.mtime)+"</div>";h+=\'<button class="btn-ghost item-menu-btn" data-action="item-menu" data-fp="\'+H(fp)+\'" data-name="\'+H(f.name)+\'" data-dir="\'+f.isDir+\'" title="Actions"><span class="material-symbols-outlined">more_vert</span></button></div>\';}' +
  '  return h+"</div>";' +
  '}' +
  'function fileGridHtml(files,base){' +
  '  if(!files.length)return \'<div style="color:#494454;padding:40px;text-align:center">\\u041f\\u0430\\u043f\\u043a\\u0430 \\u043f\\u0443\\u0441\\u0442\\u0430</div>\';' +
  '  var h=\'<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:14px">\';' +
  '  for(var i=0;i<files.length;i++){var f=files[i],fp=base?(base+"/"+f.name):f.name,checked=!!selectedItems[fp],isNew=isNewFile(fp),badge=isNew?\'<span class="new-badge">New</span>\':"";h+=\'<div class="file-grid-item \'+(checked?"selected ":"")+(isNew?"is-new":"")+\'" draggable="true" data-fp="\'+H(fp)+\'" data-name="\'+H(f.name)+\'" data-dir="\'+f.isDir+\'" style="position:relative">\';h+=\'<input class="select-check" type="checkbox" data-action="select-item" data-fp="\'+H(fp)+\'" data-name="\'+H(f.name)+\'" data-dir="\'+f.isDir+\'" style="position:absolute;top:10px;left:10px"\'+(checked?" checked":"")+">";h+=fileThumb(f.name,fp,f.isDir);h+=\'<div style="font-size:13px;font-weight:700;color:\'+(f.isDir?"#d0bcff":"#e4e1e6")+\';word-break:break-word;max-width:150px;text-align:left;pointer-events:none">\'+H(f.name)+badge+"</div>";h+=\'<div style="font-size:11px;color:#958ea0;pointer-events:none">\'+(f.isDir?((f.fileCount||0)+" объектов"):fmtSize(f.size))+"</div>";h+=\'<button class="btn-ghost item-menu-btn" data-action="item-menu" data-fp="\'+H(fp)+\'" data-name="\'+H(f.name)+\'" data-dir="\'+f.isDir+\'" title="Actions" style="position:absolute;right:10px;top:10px"><span class="material-symbols-outlined">more_vert</span></button></div>\';}' +
  '  return h+"</div>";' +
  '}' +
  'function loadRecent(){' +
  '  clearSelection(false);setSectionChrome("recent");currentPath="__recent__";savePath("__recent__");setNavActive("nav-recent");document.getElementById("file-area").innerHTML=\'<div style="color:#958ea0;padding:40px;text-align:center">\\u0417\\u0430\\u0433\\u0440\\u0443\\u0437\\u043a\\u0430...</div>\';renderBreadcrumb("");' +
  '  fetch("/api/fm/recent").then(function(r){return r.json();})' +
  '  .then(function(d){if(d.error){document.getElementById("file-area").innerHTML=\'<div style="color:#ffb4ab;padding:24px">\'+H(d.error)+"</div>";return;}var entries=(d.entries||[]).map(function(e){return{name:e.relPath,size:e.size,mtime:e.mtime,isDir:false};});lastEntries=entries;lastBase="";document.getElementById("file-area").innerHTML=\'<div style="font-size:13px;color:#958ea0;margin-bottom:12px">\\u041d\\u0435\\u0434\\u0430\\u0432\\u043d\\u0438\\u0435 \\u0444\\u0430\\u0439\\u043b\\u044b</div>\'+fileListHtml(entries,"");})' +
  '  .catch(function(){document.getElementById("file-area").innerHTML=\'<div style="color:#ffb4ab;padding:24px">\\u041e\\u0448\\u0438\\u0431\\u043a\\u0430</div>\';});' +
  '}' +
  'function getActivityActionStyle(action){' +
  '  var icon="info",color="#958ea0";' +
  '  if(action==="Создание папки"){icon="create_new_folder";color="#10b981";}' +
  '  else if(action==="Переименование"){icon="edit";color="#ffd166";}' +
  '  else if(action==="Удаление"){icon="delete";color="#ffb4ab";}' +
  '  else if(action==="Перемещение"){icon="drive_file_move";color="#a078ff";}' +
  '  else if(action==="Скачивание"){icon="download";color="#06b6d4";}' +
  '  else if(action==="Загрузка с ПК"){icon="upload_file";color="#9ddcff";}' +
  '  else if(action==="Архивация"){icon="folder_zip";color="#f59e0b";}' +
  '  else if(action==="Доступ"){icon="link";color="#38bdf8";}' +
  '  else if(action==="Загрузка по ссылке"){icon="cloud_download";color="#d2bbff";}' +
  '  return {icon:icon,color:color};' +
  '}' +
  'function loadActivityLog(){' +
  '  clearSelection(false);setSectionChrome("activity");currentPath="__activity__";savePath("__activity__");setNavActive("nav-activity");renderBreadcrumb("");' +
  '  document.getElementById("file-area").innerHTML=\'<div style="color:#958ea0;padding:40px;text-align:center">Загрузка истории активности...</div>\';' +
  '  fetch("/api/activity").then(function(r){return r.json();})' +
  '  .then(function(items){' +
  '    items=Array.isArray(items)?items:[];' +
  '    if(!items.length){' +
  '      document.getElementById("file-area").innerHTML=\'<div style="color:#494454;padding:40px;text-align:center">История активности пустая</div>\';' +
  '      return;' +
  '    }' +
  '    var h=\'<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:20px"><div style="text-align:left;"><div style="font-size:20px;font-weight:900;color:#e4e1e6">История активности</div><div style="font-size:13px;color:#958ea0;margin-top:2px">Лог последних действий с файлами и папками</div></div><button class="btn-ghost" data-action="nav-home"><span class="material-symbols-outlined">folder</span> Мои файлы</button></div>\';' +
  '    h+=\'<div style="display:flex;flex-direction:column;gap:10px">\';' +
  '    for(var i=0;i<items.length;i++){' +
  '      var x=items[i],style=getActivityActionStyle(x.action);' +
  '      h+=\'<div class="history-row" style="background:#1b1b1e;border:1px solid #2d2936;border-radius:14px;padding:14px 18px;display:flex;align-items:center;justify-content:space-between;gap:16px;transition:all .2s">\' +' +
  '        \'<div style="display:flex;align-items:center;gap:14px;min-width:0;flex:1">\' +' +
  '          \'<div style="width:40px;height:40px;border-radius:10px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;justify-content:center;flex-shrink:0;color:\' + style.color + \'"><span class="material-symbols-outlined" style="font-size:22px">\' + style.icon + \'</span></div>\' +' +
  '          \'<div style="min-width:0;text-align:left;">\' +' +
  '            \'<div style="font-size:14px;font-weight:700;color:#e4e1e6">\' + H(x.action) + \'</div>\' +' +
  '            \'<div style="font-size:12px;color:#cbc3d7;margin-top:4px;word-break:break-all">\' + H(x.details||"") + \'</div>\' +' +
  '          \'</div>\' +' +
  '        \'</div>\' +' +
  '        \'<div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0;text-align:right">\' +' +
  '          \'<span style="font-size:11px;font-weight:600;color:\' + style.color + \';background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);padding:2px 8px;border-radius:6px">@\' + H(x.username) + \'</span>\' +' +
  '          \'<span style="font-size:11px;color:#958ea0;margin-top:2px">\' + fmtDateTime(x.timestamp) + \'</span>\' +' +
  '        \'</div>\' +' +
  '      \'</div>\';' +
  '    }' +
  '    h+=\'</div>\';' +
  '    document.getElementById("file-area").innerHTML=h;' +
  '  })' +
  '  .catch(function(){document.getElementById("file-area").innerHTML=\'<div style="color:#ffb4ab;padding:24px">Ошибка загрузки активности</div>\';});' +
  '}' +
  'function doSearch(q){' +
  '  if(currentPath==="__dashboard__"||currentPath==="__recent__"||currentPath==="__activity__"||currentPath==="__settings__")return;' +
  '  if(!q.trim())return navigateTo(activePath());' +
  '  clearSelection(false);' +
  '  document.getElementById("file-area").innerHTML=\'<div style="color:#958ea0;padding:40px;text-align:center">Поиск...</div>\';' +
  '  fetch("/api/fm/search?q="+encodeURIComponent(q)).then(function(r){return r.json();})' +
  '  .then(function(d){' +
  '    if(d.error){document.getElementById("file-area").innerHTML=\'<div style="color:#ffb4ab;padding:24px">\'+H(d.error)+"</div>";return;}' +
  '    var entries=(d.entries||[]).map(function(e){return{name:e.relPath,size:e.size,mtime:e.mtime,isDir:e.isDir};});lastEntries=entries;lastBase="";' +
  '    if(!entries.length){document.getElementById("file-area").innerHTML=\'<div style="color:#494454;padding:40px;text-align:center">Ничего не найдено</div>\';return;}' +
  '    document.getElementById("file-area").innerHTML=fileListHtml(entries,"");' +
  '  })' +
  '  .catch(function(){document.getElementById("file-area").innerHTML=\'<div style="color:#ffb4ab;padding:24px">Ошибка</div>\';});' +
  '}' +
  /* ── MKDIR ── */
  'function openMkdirModal(){document.getElementById("modal-mkdir").style.display="flex";document.getElementById("mkdir-name").value="";document.getElementById("mkdir-name").focus();}' +
  'function closeMkdirModal(){document.getElementById("modal-mkdir").style.display="none";}' +
  'function createFolder(){' +
  '  var name=document.getElementById("mkdir-name").value.trim();' +
  '  if(!name)return;' +
  '  var p=activePath();' +
  '  fetch("/api/fm/mkdir",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:p,name:name})})' +
  '  .then(function(r){return r.json();}).then(function(d){closeMkdirModal();if(d.ok)navigateTo(p);else alert(d.error||"Ошибка");});' +
  '}' +
  /* ── RENAME ── */
  'function openRenameModal(fp,name,isDir){' +
  '  renameFp=fp;renameIsDir=isDir;' +
  '  var parts=splitExt(name,isDir);renameExt=parts.ext;' +
  '  document.getElementById("rename-inp").value=parts.base;' +
  '  var extEl=document.getElementById("rename-ext");' +
  '  extEl.textContent=renameExt;' +
  '  extEl.style.display=renameExt?"block":"none";' +
  '  document.getElementById("modal-rename").style.display="flex";' +
  '  document.getElementById("rename-inp").focus();' +
  '  document.getElementById("rename-inp").select();' +
  '}' +
  'function closeRenameModal(){document.getElementById("modal-rename").style.display="none";}' +
  'function doRename(){' +
  '  var newName=document.getElementById("rename-inp").value.trim();' +
  '  if(!newName)return;' +
  '  if(renameExt&&newName.toLowerCase().endsWith(renameExt.toLowerCase()))newName=newName.slice(0,-renameExt.length);' +
  '  newName=newName+renameExt;' +
  '  fetch("/api/fm/rename",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({oldPath:renameFp,newName:newName})})' +
  '  .then(function(r){return r.json();}).then(function(d){closeRenameModal();if(d.ok)navigateTo(activePath());else alert(d.error||"Ошибка");});' +
  '}' +
  /* ── DELETE ── */
  'function selectUrlMode(mode){' +
  '  document.getElementById("url-mode-inp").value=mode;' +
  '  var modes=["file","video","audio","best"];' +
  '  for(var i=0;i<modes.length;i++){' +
  '    var card=document.getElementById("url-card-"+modes[i]);' +
  '    if(!card)continue;' +
  '    if(modes[i]===mode){card.classList.add("selected");}else{card.classList.remove("selected");}' +
  '  }' +
  '}' +
  'function openUrlModal(prefill){document.getElementById("modal-url").style.display="flex";document.getElementById("url-dl-inp").value=prefill||"";document.getElementById("url-dl-inp-batch").value="";document.getElementById("url-name-inp").value="";selectUrlMode("file");document.getElementById("url-status").textContent="";if(window.urlBatchMode){toggleUrlBatchMode();}setTimeout(function(){document.getElementById("url-dl-inp").focus();},20);}' +
  'function closeUrlModal(){document.getElementById("modal-url").style.display="none";document.getElementById("url-dl-inp").value="";document.getElementById("url-dl-inp-batch").value="";document.getElementById("url-name-inp").value="";document.getElementById("url-status").textContent="";if(window.urlBatchMode){toggleUrlBatchMode();}}' +
  'function stripInputMediaExt(name){return String(name||"").replace(/\\.(mp4|webm|mkv|mov|m4v|mp3|m4a|opus|ogg|wav|flac|aac)$/i,"");}' +
  'function toggleUrlBatchMode(){' +
  '  urlBatchMode=!urlBatchMode;' +
  '  var single=document.getElementById("url-dl-inp");' +
  '  var batch=document.getElementById("url-dl-inp-batch");' +
  '  var btn=document.getElementById("url-toggle-batch");' +
  '  var nameInp=document.getElementById("url-name-inp");' +
  '  var nameHint=document.getElementById("url-name-hint");' +
  '  var wrap=single.closest(".url-dl-inp-wrap");' +
  '  var icon=wrap?wrap.querySelector(".url-inp-icon"):null;' +
  '  if(urlBatchMode){' +
  '    single.style.display="none";' +
  '    batch.style.display="block";' +
  '    btn.textContent="Одна ссылка";' +
  '    btn.style.color="var(--accent-color)";' +
  '    if(nameInp)nameInp.style.display="none";' +
  '    if(nameHint)nameHint.style.display="none";' +
  '    if(icon)icon.style.display="none";' +
  '    if(wrap){' +
  '      wrap.style.background="transparent";' +
  '      wrap.style.border="none";' +
  '      wrap.style.boxShadow="none";' +
  '      wrap.style.padding="0";' +
  '    }' +
  '    setTimeout(function(){batch.focus();},50);' +
  '  }else{' +
  '    single.style.display="block";' +
  '    batch.style.display="none";' +
  '    btn.textContent="Несколько ссылок";' +
  '    btn.style.color="var(--accent-light)";' +
  '    if(nameInp)nameInp.style.display="block";' +
  '    if(nameHint)nameHint.style.display="block";' +
  '    if(icon)icon.style.display="block";' +
  '    if(wrap){' +
  '      wrap.removeAttribute("style");' +
  '    }' +
  '    setTimeout(function(){single.focus();},50);' +
  '  }' +
  '}' +
  'function addUrlDownload(){' +
  '  var mode=document.getElementById("url-mode-inp").value;' +
  '  var st=document.getElementById("url-status");' +
  '  var folder=activePath();' +
  '  var media=mode!=="file";' +
  '  if(window.urlBatchMode){' +
  '    var text=document.getElementById("url-dl-inp-batch").value.trim();' +
  '    if(!text){st.textContent="Вставьте ссылки";return;}' +
  '    var urls=text.split("\\n").map(function(x){return x.trim();}).filter(Boolean);' +
  '    if(!urls.length){st.textContent="Вставьте ссылки";return;}' +
  '    st.textContent="Запускаю " + urls.length + " загрузок...";' +
  '    var promises=urls.map(function(url){' +
  '      return fetch(media?"/api/fm/media":"/api/fm/add-url",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url:url,filename:"",path:folder,mode:mode})})' +
  '        .then(function(r){return r.json();})' +
  '        .then(function(d){' +
  '          if(d.ok){' +
  '            var gid=d.gid||(d.job&&d.job.id);' +
  '            if(gid){knownMediaStatuses[gid]="active";markPendingUrlJob(gid,folder);}' +
  '          }' +
  '        });' +
  '    });' +
  '    Promise.all(promises).then(function(){' +
  '      st.textContent="Все загрузки добавлены!";' +
  '      setTimeout(function(){closeUrlModal();loadTransfers();},800);' +
  '    }).catch(function(){' +
  '      st.textContent="Ошибка при пакетной отправке";' +
  '    });' +
  '  }else{' +
  '    var url=document.getElementById("url-dl-inp").value.trim();' +
  '    var name=document.getElementById("url-name-inp").value.trim();' +
  '    if(!url){st.textContent="Вставь URL";return;}' +
  '    if(media)name=stripInputMediaExt(name);' +
  '    st.textContent=media?"Запускаю медиа-загрузку...":"Добавляю загрузку...";' +
  '    fetch(media?"/api/fm/media":"/api/fm/add-url",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url:url,filename:name,path:folder,mode:mode})})' +
  '      .then(function(r){return r.json();})' +
  '      .then(function(d){' +
  '        if(d.ok){' +
  '          var gid=d.gid||(d.job&&d.job.id);' +
  '          if(gid){knownMediaStatuses[gid]="active";markPendingUrlJob(gid,folder);}' +
  '          st.textContent=media?"Медиа-загрузка запущена":"Загрузка добавлена";' +
  '          closeUrlModal();' +
  '          loadTransfers();' +
  '        }else st.textContent=d.error||"Ошибка";' +
  '      }).catch(function(){st.textContent="Ошибка";});' +
  '  }' +
  '}' +
  'function updatePreviewNavButtons(){' +
  '  var prevBtn=document.getElementById("preview-btn-prev");' +
  '  var nextBtn=document.getElementById("preview-btn-next");' +
  '  var isMedia=["image","video","audio"].includes(previewKind);' +
  '  if(prevBtn)prevBtn.style.display=isMedia?"inline-flex":"none";' +
  '  if(nextBtn)nextBtn.style.display=isMedia?"inline-flex":"none";' +
  '}' +
  'function closePreview(){if(window.previewPlyrInstance){window.previewPlyrInstance.destroy();window.previewPlyrInstance=null;}document.getElementById("preview-panel").classList.remove("open");document.getElementById("preview-body").classList.remove("media-preview");document.getElementById("preview-body").innerHTML="";document.getElementById("preview-info").innerHTML="";previewKind="";previewSrc="";updatePreviewNavButtons();}' +
  'function metaRow(label,value){return \'<div class="meta-row"><div class="meta-lbl">\'+H(label)+\'</div><div class="meta-val">\'+(value||"—")+\'</div></div>\';}' +
  'function renderPreviewInfo(fp,name){' +
  '  var info=document.getElementById("preview-info");' +
  '  info.innerHTML=\'<div style="padding:20px;text-align:center;font-size:12px;color:var(--on-surf-var)">Загрузка информации...</div>\';' +
  '  fetch("/api/fm/meta?path="+encodeURIComponent(fp)).then(function(r){return r.json();}).then(function(m){' +
  '    if(m.error){info.innerHTML=\'<div style="padding:16px;color:#ffb4ab;font-size:13px">\'+H(m.error)+\'</div>\';return;}' +
  '    var links=m.publicLinks||[];var isDir=!!m.isDir;' +
  '    var ext=m.ext?m.ext.slice(1).toUpperCase():(isDir?"Папка":"Файл");' +
  '    var h="";' +
  /* name */
  '    h+=\'<div style="padding:18px 16px 0">\';' +
  '    h+=\'<div class="preview-meta-label">Название</div>\';' +
  '    h+=\'<div style="font-size:15px;font-weight:700;color:var(--on-surf);word-break:break-all;line-height:1.45;font-family:var(--font-display)">\'+H(m.name||name)+\'</div>\';' +
  '    h+=\'</div>\';' +
  /* size + type chips */
  '    if(!isDir){' +
  '      h+=\'<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:14px 16px 0">\';' +
  '      h+=\'<div class="preview-meta-chip"><div class="preview-meta-label">Размер</div><div style="font-size:14px;font-weight:700;color:var(--on-surf)">\'+fmtSize(m.size)+\'</div></div>\';' +
  '      h+=\'<div class="preview-meta-chip"><div class="preview-meta-label">Тип</div><div style="font-size:14px;font-weight:700;color:var(--on-surf)">\'+H(ext)+\'</div></div>\';' +
  '      h+=\'</div>\';' +
  '    }' +
  /* date */
  '    h+=\'<div style="padding:14px 16px 0">\';' +
  '    h+=\'<div class="preview-meta-label">Загружен</div>\';' +
  '    h+=\'<div style="font-size:13px;color:var(--on-surf)">\'+fmtDateTime(m.created)+\'</div>\';' +
  '    h+=\'</div>\';' +
  /* path chip */
  '    h+=\'<div style="padding:14px 16px 0">\';' +
  '    h+=\'<div class="preview-meta-label">Путь</div>\';' +
  '    h+=\'<div style="background:var(--surf-hi);border-radius:10px;padding:8px 12px;font-size:12px;color:var(--accent-light);word-break:break-all;line-height:1.5">\'+H(m.path||fp)+\'</div>\';' +
  '    h+=\'</div>\';' +
  /* public links */
  '    if(links.length){' +
  '      var lh=links.map(function(x){var full=window.location.origin+x.url;return \'<div style="display:flex;align-items:center;gap:6px;margin-top:5px"><a href="\'+H(x.url)+\'" target="_blank" style="color:var(--accent-light);font-size:12px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">\'+H(full)+\'</a><button class="btn-ghost" data-action="qr-link" data-url="\'+H(full)+\'" style="padding:2px 7px;min-height:24px;font-size:11px">QR</button></div>\';}).join("");' +
  '      h+=\'<div style="padding:14px 16px 0"><div class="preview-meta-label">Публичная ссылка</div>\'+lh+\'</div>\';' +
  '    }' +
  /* push buttons to bottom */
  '    h+=\'<div style="flex:1;min-height:16px"></div>\';' +
  /* action buttons */
  '    h+=\'<div style="padding:16px;display:flex;flex-direction:column;gap:8px">\';' +
  '    h+=\'<button class="btn-primary preview-action-btn" data-action="download-preview"><span class="material-symbols-outlined" style="font-size:18px">download</span>Скачать</button>\';' +
  '    h+=\'<button class="btn-ghost preview-action-btn" data-action="share-preview"><span class="material-symbols-outlined" style="font-size:18px">share</span>Поделиться</button>\';' +
  '    if(!isDir)h+=\'<button class="btn-ghost preview-action-btn" data-action="delete-preview" style="color:#ffb4ab;border-color:rgba(147,0,10,.45)"><span class="material-symbols-outlined" style="font-size:18px">delete</span>Удалить</button>\';' +
  '    h+=\'</div>\';' +
  '    info.innerHTML=h;' +
  '  }).catch(function(){info.innerHTML=\'<div style="padding:16px;color:#ffb4ab;font-size:13px">Ошибка загрузки метаданных</div>\';});' +
  '}' +
  'function fitPlyrToVideo(media,player){if(!media||!player)return;var container=player.elements&&player.elements.container;if(!container)return;function fit(){var vw=media.videoWidth||0,vh=media.videoHeight||0;if(!vw||!vh)return;var host=media.closest(".preview-media-wrap")||media.closest(".mv-stage")||container.parentElement;if(!host)return;var maxW=host.clientWidth||window.innerWidth,maxH=host.clientHeight||Math.round(window.innerHeight*.72);if(host.classList&&host.classList.contains("mv-stage"))maxH=Math.max(220,maxH-4);else maxH=Math.min(maxH||Math.round(window.innerHeight*.72),Math.round(window.innerHeight*.72));var ratio=vw/vh,w=maxW,h=w/ratio;if(h>maxH){h=maxH;w=h*ratio;}container.style.width=Math.max(180,Math.floor(w))+"px";container.style.maxWidth="100%";container.style.aspectRatio=vw+" / "+vh;var wrap=container.querySelector(".plyr__video-wrapper");if(wrap){wrap.style.aspectRatio=vw+" / "+vh;wrap.style.height=Math.floor(h)+"px";}media.style.objectFit="contain";}media.addEventListener("loadedmetadata",fit,{once:false});window.addEventListener("resize",fit);setTimeout(fit,80);setTimeout(fit,400);}\n' +
  'function getPlayableMediaFiles(kind){' +
  '  var exts=[];' +
  '  if(kind==="image")exts=["png","jpg","jpeg","gif","webp","svg","bmp"];' +
  '  else if(kind==="video")exts=["mp4","webm","ogg","mov","mkv"];' +
  '  else if(kind==="audio")exts=["mp3","wav","m4a","flac","aac","oga"];' +
  '  else return [];' +
  '  return lastEntries.filter(function(e){' +
  '    if(e.isDir)return false;' +
  '    var ext=(e.name.split(".").pop()||"").toLowerCase();' +
  '    return exts.includes(ext);' +
  '  });' +
  '}' +
  'function playSibling(direction,autoPlay){' +
  '  if(!previewFp||!previewKind)return;' +
  '  var list=getPlayableMediaFiles(previewKind);' +
  '  if(!list.length)return;' +
  '  var idx=-1;' +
  '  for(var i=0;i<list.length;i++){' +
  '    var entryPath=lastBase?(lastBase+"/"+list[i].name):list[i].name;' +
  '    if(entryPath===previewFp){idx=i;break;}' +
  '  }' +
  '  if(idx===-1)return;' +
  '  var nextIdx=idx;' +
  '  if(direction==="next"){nextIdx=(idx+1)%list.length;}' +
  '  else{nextIdx=(idx-1+list.length)%list.length;}' +
  '  var nextEntry=list[nextIdx];' +
  '  var nextFp=lastBase?(lastBase+"/"+nextEntry.name):nextEntry.name;' +
  '  var mv=document.getElementById("media-viewer");' +
  '  var isMvOpen=mv&&mv.classList.contains("open");' +
  '  if(isMvOpen){' +
  '    if(window.plyrInstance){try{window.plyrInstance.destroy();}catch(e){}window.plyrInstance=null;}' +
  '    document.getElementById("mv-stage").innerHTML="";' +
  '    document.getElementById("mv-bottom").innerHTML="";' +
  '    openPreview(nextFp,nextEntry.name,false,0,autoPlay);' +
  '    setTimeout(function(){openMediaViewer();},100);' +
  '  }else{' +
  '    openPreview(nextFp,nextEntry.name,false,0,autoPlay);' +
  '  }' +
  '}' +
  'function initPlyr(selector,isVideo,key,startTime,autoPlay){if(typeof Plyr==="undefined")return null;var opts={controls:isVideo?["play-large","play","progress","current-time","duration","mute","volume","captions","settings","pip","airplay","fullscreen"]:["play","progress","current-time","duration","mute","volume"],settings:["captions","quality","speed","loop"],keyboard:{focused:true,global:false},tooltips:{controls:true,seek:true}};var p=new Plyr(selector,opts);if(isVideo)fitPlyrToVideo(document.querySelector(selector),p);p.on("ready",function(e){var savedTime=localStorage.getItem(key);var useTime=(startTime!==undefined&&startTime!==null)?startTime:(savedTime?parseFloat(savedTime):0);e.detail.plyr.currentTime=useTime;if(autoPlay){setTimeout(function(){try{e.detail.plyr.play();}catch(err){}},50);}});p.on("timeupdate",function(e){localStorage.setItem(key,e.detail.plyr.currentTime);});p.on("ended",function(e){playSibling("next",true);});return p;}\n' +
  'function playGlobalAudio(fp,name,forcePlay){' +
  '  var audio=document.getElementById("global-audio");' +
  '  if(!audio)return;' +
  '  activeAudioFp=fp;activeAudioName=name;' +
  '  if(!window.sidebarPlayerInitialized){initSidebarPlayer();}' +
  '  var playerCard=document.getElementById("sidebar-player");' +
  '  if(playerCard)playerCard.style.display="flex";' +
  '  updatePlayerTrackInfo();' +
  '  var src="/api/fm/preview?path="+encodeURIComponent(fp);' +
  '  if(audio.src!==window.location.origin+src&&audio.getAttribute("src")!==src){audio.src=src;}' +
  '  buildAudioQueue();' +
  '  if(forcePlay){' +
  '    audio.play().catch(function(e){console.error("Audio play error:",e);});' +
  '    updatePlayButtonState(true);' +
  '  }else{' +
  '    audio.pause();updatePlayButtonState(false);' +
  '  }' +
  '}' +
  'function updatePlayerTrackInfo(){' +
  '  var name=activeAudioName;' +
  '  if(!name)return;' +
  '  var titleEl=document.getElementById("player-title");' +
  '  var artistEl=document.getElementById("player-artist");' +
  '  var baseName=name.replace(/\\.[^/.]+$/,"");' +
  '  var parts=baseName.split(" - ");' +
  '  var title=baseName;' +
  '  var artist="CloudSpace";' +
  '  var swap=localStorage.getItem("player-swap-fields")==="true";' +
  '  if(parts.length>1){' +
  '    var p0=parts[0].trim();' +
  '    var p1=parts.slice(1).join(" - ").trim();' +
  '    if(swap){' +
  '      title=p0;artist=p1;' +
  '    }else{' +
  '      title=p1;artist=p0;' +
  '    }' +
  '  }' +
  '  if(titleEl)titleEl.textContent=title;' +
  '  if(artistEl)artistEl.textContent=artist;' +
  '}' +
  'function buildAudioQueue(){' +
  '  currentAudioQueue=[];' +
  '  var exts=["mp3","wav","m4a","flac","aac","oga"];' +
  '  for(var i=0;i<lastEntries.length;i++){' +
  '    var entry=lastEntries[i];' +
  '    if(entry.isDir)continue;' +
  '    var ext=(entry.name.split(".").pop()||"").toLowerCase();' +
  '    if(exts.includes(ext)){' +
  '      var entryPath=lastBase?(lastBase+"/"+entry.name):entry.name;' +
  '      currentAudioQueue.push({fp:entryPath,name:entry.name});' +
  '    }' +
  '  }' +
  '}' +
  'function prevGlobalTrack(){' +
  '  if(!currentAudioQueue.length)return;' +
  '  var idx=-1;' +
  '  for(var i=0;i<currentAudioQueue.length;i++){if(currentAudioQueue[i].fp===activeAudioFp){idx=i;break;}}' +
  '  if(idx===-1)return;' +
  '  var prevIdx=idx-1;' +
  '  if(prevIdx<0){' +
  '    prevIdx=currentAudioQueue.length-1;' +
  '  }' +
  '  var track=currentAudioQueue[prevIdx];' +
  '  playGlobalAudio(track.fp,track.name,true);' +
  '}' +
  'function nextGlobalTrack(isAuto){' +
  '  if(!currentAudioQueue.length)return;' +
  '  var idx=-1;' +
  '  for(var i=0;i<currentAudioQueue.length;i++){if(currentAudioQueue[i].fp===activeAudioFp){idx=i;break;}}' +
  '  if(idx===-1)return;' +
  '  var repeat=localStorage.getItem("player-repeat-mode")||"off";' +
  '  if(isAuto&&repeat==="one"){' +
  '    playGlobalAudio(activeAudioFp,activeAudioName,true);' +
  '    return;' +
  '  }' +
  '  var nextIdx=idx+1;' +
  '  if(nextIdx>=currentAudioQueue.length){' +
  '    if(isAuto&&repeat==="off"){' +
  '      updatePlayButtonState(false);' +
  '      return;' +
  '    }' +
  '    nextIdx=0;' +
  '  }' +
  '  var track=currentAudioQueue[nextIdx];' +
  '  playGlobalAudio(track.fp,track.name,true);' +
  '}' +
  'function toggleGlobalPlay(){' +
  '  var audio=document.getElementById("global-audio");' +
  '  if(!audio)return;' +
  '  if(audio.paused){' +
  '    audio.play().then(function(){updatePlayButtonState(true);}).catch(function(e){console.error(e);});' +
  '  }else{' +
  '    audio.pause();updatePlayButtonState(false);' +
  '  }' +
  '}' +
  'function updatePlayButtonState(isPlaying){' +
  '  var icon=document.getElementById("player-play-icon");' +
  '  if(icon)icon.textContent=isPlaying?"pause":"play_arrow";' +
  '  var btn=document.getElementById("player-btn-play");' +
  '  if(btn)btn.title=isPlaying?"Пауза":"Воспроизведение";' +
  '}' +
  'function toggleRepeatMode(){' +
  '  var repeat=localStorage.getItem("player-repeat-mode")||"off";' +
  '  var nextRepeat="off";' +
  '  if(repeat==="off")nextRepeat="all";' +
  '  else if(repeat==="all")nextRepeat="one";' +
  '  localStorage.setItem("player-repeat-mode",nextRepeat);' +
  '  updateRepeatButtonUI();' +
  '}' +
  'function updateRepeatButtonUI(){' +
  '  var btn=document.getElementById("player-btn-repeat");' +
  '  if(!btn)return;' +
  '  var icon=btn.querySelector(".material-symbols-outlined");' +
  '  var repeat=localStorage.getItem("player-repeat-mode")||"off";' +
  '  if(repeat==="off"){' +
  '    btn.style.color="var(--outline)";' +
  '    btn.title="Повтор: выкл";' +
  '    if(icon)icon.textContent="repeat";' +
  '  }else if(repeat==="all"){' +
  '    btn.style.color="var(--accent-color)";' +
  '    btn.title="Повтор: все";' +
  '    if(icon)icon.textContent="repeat";' +
  '  }else if(repeat==="one"){' +
  '    btn.style.color="var(--accent-color)";' +
  '    btn.title="Повтор: один";' +
  '    if(icon)icon.textContent="repeat_one";' +
  '  }' +
  '}' +
  'function closeSidebarPlayer(){' +
  '  var audio=document.getElementById("global-audio");' +
  '  if(audio)audio.pause();' +
  '  var card=document.getElementById("sidebar-player");' +
  '  if(card)card.style.display="none";' +
  '  activeAudioFp="";activeAudioName="";' +
  '}' +
  'function renderPlaylistModalTracks(){' +
  '  var container=document.getElementById("playlist-modal-tracks");' +
  '  if(!container)return;' +
  '  if(!currentAudioQueue.length){' +
  '    container.innerHTML=\'<div style="color:var(--outline);text-align:center;padding:24px">Очередь пуста</div>\';' +
  '    return;' +
  '  }' +
  '  var html="";' +
  '  for(var i=0;i<currentAudioQueue.length;i++){' +
  '    var track=currentAudioQueue[i];' +
  '    var isActive=track.fp===activeAudioFp;' +
  '    var bg=isActive?"color-mix(in srgb,var(--accent-color) 12%,var(--surf-hi))":"transparent";' +
  '    var border=isActive?"1px solid color-mix(in srgb,var(--accent-color) 30%,transparent)":"1px solid transparent";' +
  '    var textColor=isActive?"var(--accent-light)":"var(--on-surf)";' +
  '    var icon=isActive?"volume_up":"music_note";' +
  '    var titleParts=track.name.replace(/\\.[^/.]+$/,"").split(" - ");' +
  '    var title=track.name;' +
  '    var artist="CloudSpace";' +
  '    if(titleParts.length>1){' +
  '      var swap=localStorage.getItem("player-swap-fields")==="true";' +
  '      if(swap){' +
  '        title=titleParts[0].trim();artist=titleParts.slice(1).join(" - ").trim();' +
  '      }else{' +
  '        title=titleParts[1].trim();artist=titleParts[0].trim();' +
  '      }' +
  '    }' +
  '    html+=\'<div class="playlist-track-row" style="display:flex;align-items:center;gap:12px;padding:8px 12px;border-radius:12px;background:\'+bg+\';border:\'+border+\';cursor:pointer;transition:background 0.2s" data-fp="\'+H(track.fp)+\'" data-name="\'+H(track.name)+\'">\';' +
  '    html+=\'  <span class="material-symbols-outlined" style="font-size:20px;color:\'+(isActive?\'var(--accent-color)\':\'var(--outline)\')+\'">\'+icon+\'</span>\';' +
  '    html+=\'  <div style="min-width:0;flex:1" class="playlist-track-click">\';' +
  '    html+=\'    <div style="font-size:13px;font-weight:700;color:\'+textColor+\';overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\'+H(title)+\'</div>\';' +
  '    html+=\'    <div style="font-size:11px;color:var(--outline);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px">\'+H(artist)+\'</div>\';' +
  '    html+=\'  </div>\';' +
  '    html+=\'  <button class="btn-ghost playlist-track-menu" style="width:28px;height:28px;padding:0;min-height:28px;border-radius:50%" data-fp="\'+H(track.fp)+\'" data-name="\'+H(track.name)+\'">\';' +
  '    html+=\'    <span class="material-symbols-outlined" style="font-size:18px">more_vert</span>\';' +
  '    html+=\'  </button>\';' +
  '    html+=\'</div>\';' +
  '  }' +
  '  container.innerHTML=html;' +
  '  container.querySelectorAll(".playlist-track-click").forEach(function(el){' +
  '    el.addEventListener("click",function(){' +
  '      var parent=el.closest(".playlist-track-row");' +
  '      if(parent){' +
  '        playGlobalAudio(parent.dataset.fp,parent.dataset.name,true);' +
  '        renderPlaylistModalTracks();' +
  '      }' +
  '    });' +
  '  });' +
  '  container.querySelectorAll(".playlist-track-menu").forEach(function(btn){' +
  '    btn.addEventListener("click",function(e){' +
  '      e.stopPropagation();' +
  '      var rect=btn.getBoundingClientRect();' +
  '      showCtxMenu(rect.left,rect.bottom+window.scrollY,btn.dataset.fp,btn.dataset.name,false);' +
  '    });' +
  '  });' +
  '}' +
  'function initSidebarPlayer(){' +
  '  if(window.sidebarPlayerInitialized)return;' +
  '  var audio=document.getElementById("global-audio");' +
  '  if(!audio)return;' +
  '  var prog=document.getElementById("player-progress");' +
  '  var curTime=document.getElementById("player-time-cur");' +
  '  var durTime=document.getElementById("player-time-dur");' +
  '  audio.addEventListener("timeupdate",function(){' +
  '    if(!audio.duration)return;' +
  '    var pct=(audio.currentTime/audio.duration)*100;' +
  '    prog.value=pct;' +
  '    curTime.textContent=fmtDuration(audio.currentTime);' +
  '  });' +
  '  audio.addEventListener("durationchange",function(){' +
  '    if(!audio.duration)return;' +
  '    durTime.textContent=fmtDuration(audio.duration);' +
  '  });' +
  '  audio.addEventListener("ended",function(){nextGlobalTrack(true);});' +
  '  audio.addEventListener("play",function(){updatePlayButtonState(true);});' +
  '  audio.addEventListener("pause",function(){updatePlayButtonState(false);});' +
  '  prog.addEventListener("input",function(){' +
  '    if(!audio.duration)return;' +
  '    var time=(prog.value/100)*audio.duration;' +
  '    audio.currentTime=time;' +
  '  });' +
  '  document.getElementById("player-btn-prev").addEventListener("click",prevGlobalTrack);' +
  '  document.getElementById("player-btn-play").addEventListener("click",toggleGlobalPlay);' +
  '  document.getElementById("player-btn-next").addEventListener("click",function(){nextGlobalTrack(false);});' +
  '  document.getElementById("player-btn-close").addEventListener("click",closeSidebarPlayer);' +
  '  document.getElementById("player-btn-repeat").addEventListener("click",toggleRepeatMode);' +
  '  document.getElementById("player-btn-playlist").addEventListener("click",function(){' +
  '    document.getElementById("modal-playlist").style.display="flex";' +
  '    renderPlaylistModalTracks();' +
  '  });' +
  '  document.getElementById("playlist-modal-close").addEventListener("click",function(){' +
  '    document.getElementById("modal-playlist").style.display="none";' +
  '  });' +
  '  document.getElementById("player-btn-details").addEventListener("click",function(){' +
  '    if(activeAudioFp&&activeAudioName){' +
  '      openPreview(activeAudioFp,activeAudioName,false);' +
  '    }' +
  '  });' +
  '  var textWrap=document.getElementById("player-text-wrap");' +
  '  if(textWrap){' +
  '    textWrap.addEventListener("click",function(){' +
  '      var swap=localStorage.getItem("player-swap-fields")==="true";' +
  '      localStorage.setItem("player-swap-fields",swap?"false":"true");' +
  '      updatePlayerTrackInfo();' +
  '    });' +
  '  }' +
  '  updateRepeatButtonUI();' +
  '  window.sidebarPlayerInitialized=true;' +
  '}' +
  'function fmtDuration(secs){' +
  '  if(isNaN(secs))return "0:00";' +
  '  var m=Math.floor(secs/60);' +
  '  var s=Math.floor(secs%60);' +
  '  return m+":"+(s<10?"0":"")+s;' +
  '}' +
  'function openPreview(fp,name,isDir,startTime,autoPlay){if(isDir){navigateTo(fp);return;}if(window.previewPlyrInstance){try{window.previewPlyrInstance.destroy();}catch(e){}window.previewPlyrInstance=null;}var body=document.getElementById("preview-body");body.innerHTML="";previewFp=fp;previewName=name;previewKind="";previewSrc="";var ext=(name.split(".").pop()||"").toLowerCase();if(["png","jpg","jpeg","gif","webp","svg","bmp"].includes(ext))previewKind="image";else if(["mp4","webm","ogg","mov","mkv"].includes(ext))previewKind="video";else if(["mp3","wav","m4a","flac","aac","oga"].includes(ext))previewKind="audio";updatePreviewNavButtons();var panel=document.getElementById("preview-panel");document.getElementById("preview-title").textContent=name;panel.classList.add("open");body.classList.remove("media-preview");renderPreviewInfo(fp,name);var src="/api/fm/preview?path="+encodeURIComponent(fp);if(previewKind==="image"){previewSrc=src;body.classList.add("media-preview");body.innerHTML=`<div id="preview-media-wrap" class="preview-media-wrap"><img class="preview-media" src="${src}" alt="${H(name)}"></div>`;return;}if(previewKind==="video"){previewSrc=src;body.classList.add("media-preview");body.innerHTML=`<div id="preview-media-wrap" class="preview-media-wrap"><video id="preview-plyr" crossorigin="anonymous" playsinline controls><source src="${src}" type="video/mp4" size="1080"><source src="${src}&quality=720" type="video/mp4" size="720"><source src="${src}&quality=480" type="video/mp4" size="480"><source src="${src}&quality=360" type="video/mp4" size="360"></video></div>`;setTimeout(function(){try{if(window.previewPlyrInstance){window.previewPlyrInstance.destroy();window.previewPlyrInstance=null;}window.previewPlyrInstance=initPlyr("#preview-plyr",true,"plyr_time_"+src,startTime,autoPlay);}catch(e){console.error(e);}},50);return;}if(previewKind==="audio"){previewSrc=src;playGlobalAudio(fp,name,false);body.classList.add("media-preview");body.innerHTML=\'<div style="padding:24px;text-align:center;color:var(--outline)"><span class="material-symbols-outlined" style="font-size:48px;color:var(--accent-color);margin-bottom:10px">music_note</span><div style="font-size:14px;font-weight:700;color:var(--on-surf);margin-bottom:4px">Воспроизведение...</div><div style="font-size:12px;color:var(--outline)">Трек загружен в плеер сайдбара</div></div>\';return;}if(ext==="pdf"){body.innerHTML=`<iframe src="${src}" style="width:100%;height:70vh;border:0;border-radius:10px"></iframe>`;return;}if(["txt","log","md","json","csv","js","css","html","xml","yml","yaml","ini","conf","py","sh"].includes(ext)){body.textContent="Загрузка предпросмотра...";fetch(src).then(function(r){return r.text();}).then(function(t){if(t.length<150000&&["js","css","html","xml","json","py","sh","yml","yaml","md"].includes(ext)){var highlighted=highlightCode(t,ext);body.innerHTML=`<pre style="white-space:pre-wrap;font-size:12px;line-height:1.55;margin:0;font-family:\'Fira Code\',Consolas,monospace;background:#18181f;padding:12px;border-radius:10px;color:#f8f8f2">${highlighted}</pre>`;}else{body.innerHTML=`<pre style="white-space:pre-wrap;font-size:12px;line-height:1.55;margin:0">${H(t)}</pre>`;}}).catch(function(){body.textContent="Не удалось загрузить предпросмотр";});return;}body.innerHTML=`<div style="padding:32px;text-align:center;color:#958ea0">Предпросмотр недоступен<br><br><a class="btn-primary" href="/api/fm/download?path=${encodeURIComponent(fp)}" download style="display:inline-block;text-decoration:none">Скачать файл</a></div>`;}' +
  'function openPreviewShell(fp,name){if(window.previewPlyrInstance){try{window.previewPlyrInstance.destroy();}catch(e){}window.previewPlyrInstance=null;}var body=document.getElementById("preview-body");body.innerHTML="";previewFp=fp;previewName=name;previewKind="";previewSrc="";updatePreviewNavButtons();var panel=document.getElementById("preview-panel");document.getElementById("preview-title").textContent=name;panel.classList.add("open");body.classList.remove("media-preview");renderPreviewInfo(fp,name);return body;}' +
  'function renderDocPreview(fp,name){var body=openPreviewShell(fp,name);body.innerHTML=\'<div style="color:#958ea0;padding:20px">Загрузка документа...</div>\';fetch("/api/fm/doc-preview?path="+encodeURIComponent(fp)).then(function(r){return r.json();}).then(function(d){if(!d.ok){body.innerHTML=\'<div style="padding:24px;color:#ffb4ab">\'+H(d.error||"Не удалось открыть документ")+\'</div>\';return;}if(d.type==="sheet"){var sheets=d.sheets||[];if(!sheets.length){body.innerHTML=\'<div style="padding:24px;color:#958ea0">В таблице нет листов</div>\';return;}var h=\'<div class="doc-tabs">\';for(var i=0;i<sheets.length;i++)h+=\'<button class="doc-tab" data-sheet="\'+i+\'">\'+H(sheets[i].name)+\'</button>\';h+=\'</div><div id="sheet-preview" class="doc-preview">\'+(sheets[0].html||"")+\'</div>\';body.innerHTML=h;body.querySelectorAll("[data-sheet]").forEach(function(btn){btn.addEventListener("click",function(){var idx=parseInt(btn.dataset.sheet,10)||0;document.getElementById("sheet-preview").innerHTML=sheets[idx].html||"";});});return;}body.innerHTML=\'<div class="doc-preview">\'+(d.html||"")+\'</div>\';}).catch(function(){body.innerHTML=\'<div style="padding:24px;color:#ffb4ab">Ошибка предпросмотра</div>\';});}' +
  'function renderArchivePreview(fp,name){var body=openPreviewShell(fp,name);body.innerHTML=\'<div style="color:#958ea0;padding:20px">Читаю архив...</div>\';fetch("/api/fm/archive/list?path="+encodeURIComponent(fp)).then(function(r){return r.json();}).then(function(d){if(!d.ok){body.innerHTML=\'<div style="padding:24px;color:#ffb4ab">\'+H(d.error||"Не удалось открыть архив")+\'<div style="margin-top:8px;color:#958ea0;font-size:12px">\'+H(d.details||"")+\'</div></div>\';return;}var items=d.entries||[];if(!items.length){body.innerHTML=\'<div style="padding:24px;color:#958ea0">Архив пуст</div>\';return;}var h=\'<div style="display:flex;justify-content:space-between;gap:10px;margin-bottom:10px;color:#958ea0;font-size:12px"><span>\'+items.length+\' items</span><a class="btn-ghost" href="/api/fm/download?path=\'+encodeURIComponent(fp)+\'" download style="text-decoration:none;padding:4px 10px;min-height:28px">Скачать архив</a></div><table class="archive-table"><tbody>\';items.forEach(function(x){var icon=x.isDir?"folder":"draft";var cls=x.isDir?"archive-path archive-dir":"archive-path";h+=\'<tr><td style="width:28px"><span class="material-symbols-outlined" style="font-size:18px">\'+icon+\'</span></td><td><div class="\'+cls+\'" title="\'+H(x.path)+\'">\'+H(x.path)+\'</div></td><td style="width:76px;color:#958ea0;white-space:nowrap">\'+(x.isDir?"":fmtSize(x.size||0))+\'</td><td style="width:42px;text-align:right">\'+(x.isDir?"":\'<a class="btn-ghost" href="/api/fm/archive/download?path=\'+encodeURIComponent(fp)+\'&entry=\'+encodeURIComponent(x.path)+\'" download style="padding:3px 8px;min-height:24px;text-decoration:none">↓</a>\')+\'</td></tr>\';});h+=\'</tbody></table>\';body.innerHTML=h;}).catch(function(){body.innerHTML=\'<div style="padding:24px;color:#ffb4ab">Ошибка чтения архива</div>\';});}' +
  'var cloudBasicOpenPreview=openPreview;openPreview=function(fp,name,isDir,startTime,autoPlay){if(isDir){navigateTo(fp);return;}var ext=(name.split(".").pop()||"").toLowerCase();if(["docx","xlsx","csv"].includes(ext))return renderDocPreview(fp,name);if(["zip","rar","7z","tar","gz","bz2","xz"].includes(ext))return renderArchivePreview(fp,name);return cloudBasicOpenPreview(fp,name,isDir,startTime,autoPlay);};' +
  'window.plyrInstance = null;' +
  'window.previewPlyrInstance = null;' +
  'function closeMediaViewer(){' +
  '  var v=document.getElementById("media-viewer");' +
  '  var startPreviewPlayback=false,lastTime=0;' +
  '  var media=document.getElementById("mv-media");' +
  '  if(media){' +
  '    lastTime=media.currentTime||0;' +
  '    startPreviewPlayback=!media.paused;' +
  '    try{media.pause();}catch(e){}' +
  '  }' +
  '  if(window.plyrInstance){' +
  '    if(lastTime===0) lastTime=window.plyrInstance.currentTime||0;' +
  '    if(!startPreviewPlayback) startPreviewPlayback=window.plyrInstance.playing||false;' +
  '    try{window.plyrInstance.destroy();}catch(e){}window.plyrInstance=null;' +
  '  }' +
  '  v.classList.remove("open");' +
  '  document.getElementById("mv-stage").innerHTML="";' +
  '  document.getElementById("mv-bottom").innerHTML="";' +
  '  if(previewFp && (previewKind==="video" || previewKind === "audio")) {' +
  '    openPreview(previewFp, previewName, false, lastTime, startPreviewPlayback);' +
  '  } else if (previewFp && previewKind === "image") {' +
  '    openPreview(previewFp, previewName, false);' +
  '  }' +
  '}' +
'function openMediaViewer(){' +
  '  if(!previewSrc||!previewKind)return;' +
  '  mvZoom=1; window.mvTranslateX=0; window.mvTranslateY=0;' +
  '  document.getElementById("mv-title").textContent=previewName||"Media";' +
  '  var v=document.getElementById("media-viewer"),stage=document.getElementById("mv-stage"),bottom=document.getElementById("mv-bottom");' +
  '  var startPlayback=false,startTime=0;' +
  '  var smallMedia=document.getElementById("preview-plyr");' +
  '  if(smallMedia){' +
  '    startTime=smallMedia.currentTime||0;' +
  '    startPlayback=!smallMedia.paused;' +
  '    try{smallMedia.pause();}catch(e){}' +
  '  }' +
  '  if(window.previewPlyrInstance){' +
  '    if(startTime===0) startTime=window.previewPlyrInstance.currentTime||0;' +
  '    if(!startPlayback) startPlayback=window.previewPlyrInstance.playing||false;' +
  '    try{window.previewPlyrInstance.destroy();}catch(e){}window.previewPlyrInstance=null;' +
  '  }' +
  '  var previewBody=document.getElementById("preview-body");' +
  '  if(previewBody) previewBody.innerHTML="";' +
  '  var shotBtn=document.getElementById("mv-btn-screenshot");' +
  '  if(shotBtn){shotBtn.style.display=(previewKind==="video")?"block":"none";}' +
  '  if(previewKind==="image"){' +
  '    stage.innerHTML=\'<img id="mv-media" src="\' + previewSrc + \'" alt="\' + H(previewName) + \'" style="max-height:100%;max-width:100%;object-fit:contain;transition:transform 0.1s ease-out;cursor:grab;transform-origin:center center">\';' +
  '    bottom.innerHTML=\'<button class="mv-icon" data-action="mv-zoom-out"><span class="material-symbols-outlined">zoom_out</span></button><button class="mv-icon" data-action="mv-fit"><span class="material-symbols-outlined">fit_screen</span></button><button class="mv-icon" data-action="mv-zoom-in"><span class="material-symbols-outlined">zoom_in</span></button><div style="flex:1"></div><div class="mv-time">Изображение</div>\';' +
  '    setTimeout(function(){' +
  '      var m=document.getElementById("mv-media");' +
  '      if(!m)return;' +
  '      var isDragging = false;' +
  '      var startX, startY;' +
  '      function updateTransform() {' +
  '        m.style.transform = "scale(" + mvZoom + ") translate(" + window.mvTranslateX + "px, " + window.mvTranslateY + "px)";' +
  '      }' +
  '      m.addEventListener("wheel", function(e) {' +
  '        e.preventDefault();' +
  '        var delta = e.deltaY < 0 ? 0.15 : -0.15;' +
  '        mvZoom = Math.min(6, Math.max(0.25, mvZoom + delta));' +
  '        m.style.transition = "transform 0.05s ease-out";' +
  '        updateTransform();' +
  '      });' +
  '      m.addEventListener("mousedown", function(e) {' +
  '        if (mvZoom <= 1) return;' +
  '        isDragging = true;' +
  '        startX = e.clientX - window.mvTranslateX * mvZoom;' +
  '        startY = e.clientY - window.mvTranslateY * mvZoom;' +
  '        m.style.cursor = "grabbing";' +
  '        m.style.transition = "none";' +
  '        e.preventDefault();' +
  '      });' +
  '      document.addEventListener("mousemove", function(e) {' +
  '        if (!isDragging) return;' +
  '        window.mvTranslateX = (e.clientX - startX) / mvZoom;' +
  '        window.mvTranslateY = (e.clientY - startY) / mvZoom;' +
  '        updateTransform();' +
  '      });' +
  '      document.addEventListener("mouseup", function() {' +
  '        if (isDragging) {' +
  '          isDragging = false;' +
  '          m.style.cursor = "grab";' +
  '        }' +
  '      });' +
  '      var touchStartX = 0;' +
  '      var touchStartY = 0;' +
  '      m.addEventListener("touchstart", function(e) {' +
  '        if (e.touches.length === 1) {' +
  '          touchStartX = e.touches[0].clientX;' +
  '          touchStartY = e.touches[0].clientY;' +
  '        }' +
  '      }, {passive: true});' +
  '      m.addEventListener("touchend", function(e) {' +
  '        if (mvZoom > 1) return;' +
  '        if (e.changedTouches.length === 1) {' +
  '          var touchEndX = e.changedTouches[0].clientX;' +
  '          var touchEndY = e.changedTouches[0].clientY;' +
  '          var diffX = touchEndX - touchStartX;' +
  '          var diffY = touchEndY - touchStartY;' +
  '          if (Math.abs(diffX) > 60 && Math.abs(diffY) < 40) {' +
  '            if (diffX < 0) { playSibling("next", true); }' +
  '            else { playSibling("prev", true); }' +
  '          }' +
  '        }' +
  '      }, {passive: true});' +
  '    }, 50);' +
  '  } else {' +
  '    var autoplayAttr=startPlayback?"autoplay":"";' +
  '    if(previewKind==="video"){' +
  '      stage.innerHTML=\'<video id="mv-media" crossorigin="anonymous" playsinline controls style="max-height:100%" \' + autoplayAttr + \'><source src="\' + previewSrc + \'" type="video/mp4" size="1080"><source src="\' + previewSrc + \'&quality=720" type="video/mp4" size="720"><source src="\' + previewSrc + \'&quality=480" type="video/mp4" size="480"><source src="\' + previewSrc + \'&quality=360" type="video/mp4" size="360"></video>\';' +
  '    }else{' +
  '      stage.innerHTML=\'<audio id="mv-media" src="\' + previewSrc + \'" crossorigin="anonymous" playsinline controls style="max-height:100%" \' + autoplayAttr + \'></audio>\';' +
  '    }' +
  '    var mediaFiles=getPlayableMediaFiles(previewKind);' +
  '    var plHtml=\'<div class="plyr-playlist" style="width:100%;padding:10px 16px;background:rgba(20,20,24,0.72);border-top:1px solid rgba(255,255,255,0.06);box-sizing:border-box">\';' +
  '    plHtml+=\'<div style="font-size:12px;font-weight:700;color:var(--accent-light);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px">Плейлист папки</div>\';' +
  '    plHtml+=\'<div class="pl-carousel" style="display:flex;gap:10px;overflow-x:auto;padding-bottom:6px;scrollbar-width:thin">\';' +
  '    for(var idx=0;idx<mediaFiles.length;idx++){' +
  '      var item=mediaFiles[idx];' +
  '      var entryPath=lastBase?(lastBase+"/"+item.name):item.name;' +
  '      var isActive=entryPath===previewFp;' +
  '      var cardStyle=\'flex:0 0 auto;width:160px;padding:8px 12px;border-radius:10px;background:\' + (isActive?\'color-mix(in srgb,var(--accent-color) 12%,#1b1b1e)\':\'#1b1b1e\') + \';border:1px solid \' + (isActive?\'var(--accent-color)\':\'rgba(255,255,255,0.08)\') + \';cursor:pointer;transition:transform .2s,border-color .2s\';' +
  "      plHtml+='<div class=\"pl-card\" style=\"' + cardStyle + '\" onclick=\"playSiblingDirect(\\\'\' + entryPath.split(String.fromCharCode(39)).join('\\\\\\\'') + \'\\\',\\\'\' + item.name.split(String.fromCharCode(39)).join('\\\\\\\'') + \'\\\')\">';" +
  '      plHtml+=\'<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px"><span class="material-symbols-outlined" style="font-size:16px;color:\' + (isActive?\'var(--accent-color)\':\'#958ea0\') + \'">\' + (previewKind===\'video\'?\'movie\':\'music_note\') + \'</span>\';' +
  '      plHtml+=\'<span style="font-size:10px;color:#958ea0">\' + fmtSize(item.size) + \'</span></div>\';' +
  '      plHtml+=\'<div style="font-size:11px;font-weight:700;color:\' + (isActive?\'#fff\':\'#e4e1e6\') + \';overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="\' + H(item.name) + \'">\' + H(item.name) + \'</div>\';' +
  '      plHtml+=\'</div>\';' +
  '    }' +
  '    plHtml+=\'</div></div>\';' +
  '    bottom.innerHTML=plHtml;' +
  '    setTimeout(function() {' +
  '      if(typeof Plyr === "undefined") { console.error("Plyr is not loaded!"); return; }' +
  '      var isVideo = previewKind === "video";' +
  '      var opts = { ' +
  '        controls: isVideo ? ["play-large", "play", "progress", "current-time", "duration", "mute", "volume", "captions", "settings", "pip", "airplay", "fullscreen"] : ["play", "progress", "current-time", "duration", "mute", "volume"],' +
  '        settings: ["captions", "quality", "speed", "loop"],' +
  '        keyboard: { focused: true, global: true },' +
  '        tooltips: { controls: true, seek: true }' +
  '      };' +
  '      try {' +
  '        if(window.plyrInstance) { window.plyrInstance.destroy(); }' +
  '        window.plyrInstance = new Plyr("#mv-media", opts);' +
  '        window.plyrInstance.on("ready", function(e){ ' +
  '           console.log("Plyr Ready event");' +
  '           var savedTime = localStorage.getItem("plyr_time_" + previewSrc);' +
  '           var useTime = startTime > 0 ? startTime : (savedTime ? parseFloat(savedTime) : 0);' +
  '           e.detail.plyr.currentTime = useTime;' +
  '           if (startPlayback) {' +
  '             setTimeout(function() { try { e.detail.plyr.play(); } catch(err) {} }, 50);' +
  '           }' +
  '        });' +
  '        window.plyrInstance.on("timeupdate", function(e){ ' +
  '           localStorage.setItem("plyr_time_" + previewSrc, e.detail.plyr.currentTime);' +
  '        });' +
  '        window.plyrInstance.on("ended", function(e){ ' +
  '           playSibling("next", true);' +
  '        });' +
  '      } catch(err) { console.error("Plyr failed to init:", err); }' +
  '    }, 150);' +
  '  }' +
  '  v.classList.add("open");' +
  '}' +
  'function playSiblingDirect(fp,name){' +
  '  if(window.plyrInstance){try{window.plyrInstance.destroy();}catch(e){}window.plyrInstance=null;}' +
  '  document.getElementById("mv-stage").innerHTML="";' +
  '  document.getElementById("mv-bottom").innerHTML="";' +
  '  openPreview(fp,name,false,0,true);' +
  '  setTimeout(function(){openMediaViewer();},100);' +
  '}' +
  'function bindMediaControls(){}' +
'function mediaViewerAction(action){' +
  '  var m=document.getElementById("mv-media"),viewer=document.getElementById("media-viewer");' +
  '  if(action==="mv-close")return closeMediaViewer();' +
  '  if(action==="mv-download"&&previewFp)window.location.href="/api/fm/download?path="+encodeURIComponent(previewFp);' +
  '  if(action==="mv-share"&&previewFp)shareOne(previewFp);' +
  '  if(action==="mv-zoom-in"&&m){' +
  '    mvZoom=Math.min(6,mvZoom+.25);' +
  '    m.style.transform="scale("+mvZoom+") translate("+(window.mvTranslateX||0)+"px, "+(window.mvTranslateY||0)+"px)";' +
  '  }' +
  '  if(action==="mv-zoom-out"&&m){' +
  '    mvZoom=Math.max(.25,mvZoom-.25);' +
  '    m.style.transform="scale("+mvZoom+") translate("+(window.mvTranslateX||0)+"px, "+(window.mvTranslateY||0)+"px)";' +
  '  }' +
  '  if(action==="mv-fit"&&m){' +
  '    mvZoom=1; window.mvTranslateX=0; window.mvTranslateY=0;' +
  '    m.style.transform="scale(1) translate(0px, 0px)";' +
  '  }' +
  '  if(action==="mv-screenshot"){' +
  '    var v=document.getElementById("mv-media");' +
  '    if(!v || previewKind!=="video")return;' +
  '    try{' +
  '      var canvas=document.createElement("canvas");' +
  '      canvas.width=v.videoWidth||v.clientWidth;' +
  '      canvas.height=v.videoHeight||v.clientHeight;' +
  '      var ctx=canvas.getContext("2d");' +
  '      ctx.drawImage(v,0,0,canvas.width,canvas.height);' +
  '      var imgData=canvas.toDataURL("image/png");' +
  '      var statusEl=document.getElementById("mv-title");' +
  '      var oldTitle=statusEl.textContent;' +
  '      statusEl.textContent="📸 Сохраняю скриншот...";' +
  '      fetch("/api/fm/video-screenshot",{' +
  '        method:"POST",' +
  '        headers:{"Content-Type":"application/json"},' +
  '        body:JSON.stringify({path:previewFp,folder:activePath(),img:imgData})' +
  '      }).then(function(r){return r.json();}).then(function(d){' +
  '        if(d.ok){' +
  '          statusEl.textContent="📸 Кадр сохранён!";' +
  '          refreshCurrent();' +
  '          setTimeout(function(){statusEl.textContent=oldTitle;},2000);' +
  '        }else{' +
  '          statusEl.textContent="❌ Ошибка сохранения";' +
  '          setTimeout(function(){statusEl.textContent=oldTitle;},2000);' +
  '        }' +
  '      }).catch(function(){' +
  '        statusEl.textContent="❌ Ошибка сети";' +
  '        setTimeout(function(){statusEl.textContent=oldTitle;},2000);' +
  '      });' +
  '    }catch(err){' +
  '      alert("Не удалось сделать скриншот: "+err.message);' +
  '    }' +
  '  }' +
  '}' +
  'function deleteItem(fp,name,isDir){' +
  '  if(!confirm("Удалить " + name + "?"))return;' +
  '  fetch("/api/fm/delete",{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:fp,isDir:isDir})})' +
  '  .then(function(r){return r.json();}).then(function(d){if(d.ok)navigateTo(activePath());else alert(d.error||"Ошибка");});' +
  '}' +
  /* ── UPLOAD ── */
  'function deleteSelected(){' +
  '  var items=selectedList();' +
  '  if(!items.length)return;' +
  '  if(!confirm("Удалить выбранные: " + items.length + "?"))return;' +
  '  Promise.all(items.map(function(it){return fetch("/api/fm/delete",{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:it.fp,isDir:it.isDir})}).then(function(r){return r.json();});}))' +
  '  .then(function(results){var failed=results.filter(function(x){return !x.ok;});clearSelection(false);refreshCurrent();if(failed.length)alert("Не удалось удалить: "+failed.length);})' +
  '  .catch(function(){alert("Ошибка удаления");});' +
  '}' +
  'function uploadFiles(files,folderPath){' +
  '  if(!files||!files.length)return;' +
  '  var panel=document.getElementById("upload-panel");' +
  '  var fill=document.getElementById("upload-fill");' +
  '  var status=document.getElementById("upload-status");' +
  '  var title=document.getElementById("upload-title");' +
  '  var list=document.getElementById("upload-files");' +
  '  var speedEl=document.getElementById("upload-speed");' +
  '  var etaEl=document.getElementById("upload-eta");' +
  '  var bytesEl=document.getElementById("upload-bytes");' +
  '  panel.style.display="block";fill.classList.remove("done");fill.style.width="0%";' +
  '  status.textContent="0%";title.textContent="Загрузка файлов";' +
  '  if(speedEl)speedEl.textContent="";if(etaEl)etaEl.textContent="";if(bytesEl)bytesEl.textContent="";' +
  '  var names=[];for(var n=0;n<Math.min(files.length,4);n++)names.push(\'<div class="upload-file">\'+H(files[n].name)+\'</div>\');' +
  '  if(files.length>4)names.push(\'<div class="upload-file">+ \'+(files.length-4)+\' more</div>\');' +
  '  list.innerHTML=names.join("");' +
  '  var fd=new FormData();' +
  '  var totalBytes=0;for(var i=0;i<files.length;i++){fd.append("files",files[i]);totalBytes+=files[i].size;}' +
  '  var xhr=new XMLHttpRequest();' +
  '  var startTime=Date.now();var lastLoaded=0;var lastTime=Date.now();' +
  '  uploadBusy=true;' +
  '  xhr.open("POST","/api/fm/upload?path="+encodeURIComponent(folderPath||""));' +
  '  xhr.upload.onprogress=function(e){' +
  '    if(!e.lengthComputable)return;' +
  '    var pct=Math.round(e.loaded/e.total*100);' +
  '    fill.style.width=pct+"%";status.textContent=pct+"%";' +
  '    var now=Date.now();var dt=(now-lastTime)/1000;' +
  '    if(dt>0.3){var bps=(e.loaded-lastLoaded)/dt;lastLoaded=e.loaded;lastTime=now;' +
  '      if(speedEl)speedEl.textContent=fmtSize(Math.max(0,bps))+"/с";' +
  '      if(bytesEl)bytesEl.textContent=fmtSize(e.loaded)+" / "+fmtSize(e.total);' +
  '      if(etaEl&&bps>0){var rem=Math.max(0,e.total-e.loaded);var secs=Math.ceil(rem/bps);' +
  '        etaEl.textContent=secs>3600?(Math.ceil(secs/3600)+" ч"):secs>60?(Math.ceil(secs/60)+" мин"):(secs+" с");' +
  '      }' +
  '    }' +
  '  };' +
  '  xhr.onload=function(){' +
  '    uploadBusy=false;' +
  '    if(xhr.status>=200&&xhr.status<300){' +
  '      fill.style.width="100%";fill.classList.add("done");' +
  '      status.textContent="Готово";title.textContent="Файлы загружены";' +
  '      var elapsed=(Date.now()-startTime)/1000;var avgSpd=elapsed>0?totalBytes/elapsed:0;' +
  '      if(speedEl)speedEl.textContent="Avg: "+fmtSize(avgSpd)+"/с";' +
  '      if(bytesEl)bytesEl.textContent=fmtSize(totalBytes);' +
  '      if(etaEl)etaEl.textContent="";' +
  '      refreshCurrent();loadDisk();' +
  '      setTimeout(function(){panel.style.display="none";},3000);' +
  '    }else{status.textContent="Ошибка "+xhr.status;}' +
  '  };' +
  '  xhr.onerror=function(){uploadBusy=false;status.textContent="Ошибка соединения";};' +
  '  xhr.onabort=function(){uploadBusy=false;status.textContent="Загрузка отменена";};' +
  '  xhr.send(fd);' +
  '}' +
  /* ── CONTEXT MENU ── */
  'function showCtxMenu(x,y,fp,name,isDir){' +
  '  ctxFp=fp;ctxName=name;ctxIsDir=isDir;' +
  '  var m=document.getElementById("ctx-menu");' +
  '  var h="";' +
  '  if(isDir){' +
  '    h+=\'<div class="ctx-item" data-ctx="open">\u{1F4C2} Открыть</div>\';' +
  '    h+=\'<div class="ctx-item" data-ctx="download">📦 Скачать ZIP</div>\';' +
  '  }else{' +
  '    h+=\'<div class="ctx-item" data-ctx="download">↓ Скачать</div>\';' +
  '  }' +
  '  if(!isDir)h+=\'<div class="ctx-item" data-ctx="preview">👁 Предпросмотр</div>\';' +
  '  h+=\'<div class="ctx-sep"></div>\';' +
  '  h+=\'<div class="ctx-item" data-ctx="share">🔗 Публичная ссылка</div>\';' +
  '  if(!isDir)h+=\'<div class="ctx-item" data-ctx="share-manage"><span class="material-symbols-outlined" style="font-size:18px;vertical-align:-4px">admin_panel_settings</span> Управление ссылками</div>\';' +
  '  h+=\'<div class="ctx-item" data-ctx="rename">✏️ Переименовать</div>\';' +
  '  h+=\'<div class="ctx-item" data-ctx="copypath">\u{1F4CB} Копировать путь</div>\';' +
  '  h+=\'<div class="ctx-sep"></div>\';' +
  '  h+=\'<div class="ctx-item danger" data-ctx="delete">\u{1F5D1}️ Удалить</div>\';' +
  '  m.innerHTML=h;' +
  '  m.style.display="block";m.classList.remove("open");void m.offsetWidth;m.classList.add("open");' +
  '  var mw=200,mh=m.scrollHeight||160;' +
  '  var ww=window.innerWidth,wh=window.innerHeight;' +
  '  m.style.left=Math.max(8,(x+mw>ww?ww-mw-8:x))+"px";' +
  '  m.style.top=Math.max(8,(y+mh>wh?wh-mh-8:y))+"px";' +
  '}' +
  'function hideCtxMenu(){var m=document.getElementById("ctx-menu");m.style.display="none";m.classList.remove("open");}' +
  /* ── DRAG & DROP ── */
  'function clearDragOver(){document.querySelectorAll(".drag-over,.drop-target").forEach(function(el){el.classList.remove("drag-over");el.classList.remove("drop-target");});}' +
  /* TRANSFERS */
  'function loadTransfers(){' +
  '  Promise.all([fetch("/api/downloads").then(function(r){return r.json();}).catch(function(){return[];}),fetch("/api/fm/media-jobs?scope=active").then(function(r){return r.json();}).catch(function(){return[];}),fetch("/api/fm/media-jobs?scope=history").then(function(r){return r.json();}).catch(function(){return[];})])' +
  '  .then(function(all){' +
  '    var items=(Array.isArray(all[0])?all[0]:[]).filter(function(x){return ["active","waiting","paused"].includes(x.status);});var media=Array.isArray(all[1])?all[1]:[];var history=Array.isArray(all[2])?all[2]:[];' +
  '    history.forEach(function(j){if(j.status==="complete"){rememberNewFile(j);}var prev=knownMediaStatuses[j.id];var pending=pendingUrlJobs[j.id];var shouldSignal=(prev&&prev!==j.status)||!!pending;if(pending&&["active","waiting","paused","starting","processing"].includes(j.status)){pending.seen=true;savePendingUrlJobs();}if(shouldSignal){if(j.status==="complete"){notifyDone(j.name||j.file||"Download");rememberNewFile(j);clearPendingUrlJob(j.id);loadDisk();if(currentPath==="__dashboard__"||currentPath==="__recent__"||currentPath==="__url_history__"||currentPath===(j.folder||""))refreshCurrent();}else if(j.status==="error"||j.status==="cancelled"){notifyFail(j.name||j.file||"Download",j.error||"unknown error");clearPendingUrlJob(j.id);loadDisk();if(currentPath==="__dashboard__"||currentPath==="__url_history__"||currentPath===(j.folder||""))refreshCurrent();}}knownMediaStatuses[j.id]=j.status;});' +
  '    var count=items.length+media.length;setTransfersUi(count);if(!count){document.getElementById("transfers-list").innerHTML="";return;}' +
  '    var h=\'<div class="transfer-section-title">\\u0421\\u0435\\u0439\\u0447\\u0430\\u0441 \\u0437\\u0430\\u0433\\u0440\\u0443\\u0436\\u0430\\u0435\\u0442\\u0441\\u044f</div>\';' +
  '    for(var i=0;i<items.length;i++){' +
  '      var t=items[i],pct=t.progress||0,name=t.name||t.gid||"Download",left=Math.max(0,(t.size||0)-(t.downloaded||0));var eta=(t.speed>0&&left>0)?Math.ceil(left/t.speed):0;' +
  '      h+=\'<div class="transfer-card is-active"><div class="transfer-top"><div class="transfer-name">\'+H(name)+\'</div><div class="transfer-status">\'+H(t.status||"unknown")+\'</div><div style="font-size:12px;color:#958ea0;width:42px;text-align:right">\'+pct+\'%</div></div>\';' +
  '      h+=\'<div class="progress-track"><div class="progress-fill\'+(pct>=100?" done":"")+\'" style="width:\'+pct+\'%"></div></div>\';' +
  '      h+=\'<div class="transfer-meta"><div>\\u0421\\u043a\\u0430\\u0447\\u0430\\u043d\\u043e: \'+fmtSize(t.downloaded)+\' / \'+fmtSize(t.size)+\'</div><div>\\u0421\\u043a\\u043e\\u0440\\u043e\\u0441\\u0442\\u044c: \'+fmtSpeed(t.speed)+\'</div><div>\\u041e\\u0441\\u0442\\u0430\\u043b\\u043e\\u0441\\u044c: \'+(eta?Math.ceil(eta/60)+" \\u043c\\u0438\\u043d":"-")+\'</div><div>\\u0421\\u043e\\u0435\\u0434\\u0438\\u043d\\u0435\\u043d\\u0438\\u044f: \'+(t.connections||0)+\'</div></div>\';' +
  '      if(t.errorMessage)h+=\'<div style="font-size:12px;color:#ffb4ab">\'+H(t.errorMessage)+\'</div>\';h+=\'<div class="transfer-controls">\';' +
  '      if(t.status==="active")h+=\'<button class="btn-ghost" data-action="transfer-pause" data-gid="\'+H(t.gid)+\'"><span class="material-symbols-outlined">pause</span> \\u041f\\u0430\\u0443\\u0437\\u0430</button>\';' +
  '      if(t.status==="paused"||t.status==="waiting")h+=\'<button class="btn-ghost" data-action="transfer-resume" data-gid="\'+H(t.gid)+\'"><span class="material-symbols-outlined">play_arrow</span> \\u041f\\u0440\\u043e\\u0434\\u043e\\u043b\\u0436\\u0438\\u0442\\u044c</button>\';' +
  '      h+=\'<button class="btn-ghost" data-action="transfer-remove" data-gid="\'+H(t.gid)+\'" style="color:#ffb4ab;border-color:#93000a"><span class="material-symbols-outlined">close</span> \\u0423\\u0431\\u0440\\u0430\\u0442\\u044c</button></div></div>\';' +
  '    }' +
  '    for(var j=0;j<media.length;j++){' +
  '      var mt=media[j],mp=Math.round(mt.progress||0);h+=\'<div class="transfer-card is-active"><div class="transfer-top"><div class="transfer-name">\'+H(mt.name||mt.file||"Media download")+\'</div><div class="transfer-status">\'+H((mt.mode||"media")+" / "+(mt.status||"unknown"))+\'</div><div style="font-size:12px;color:#958ea0;width:42px;text-align:right">\'+mp+\'%</div></div>\';' +
  '      h+=\'<div class="progress-track"><div class="progress-fill" style="width:\'+mp+\'%"></div></div>\';' +
  '      h+=\'<div class="transfer-meta"><div>\\u0418\\u0441\\u0442\\u043e\\u0447\\u043d\\u0438\\u043a: media</div><div>\\u0421\\u043a\\u043e\\u0440\\u043e\\u0441\\u0442\\u044c: \'+H(mt.speed||"-")+\'</div><div>ETA: \'+H(mt.eta||"-")+\'</div><div>\\u041f\\u0430\\u043f\\u043a\\u0430: \'+H(mt.folder||"\\u041c\\u043e\\u0438 \\u0444\\u0430\\u0439\\u043b\\u044b")+\'</div></div>\';' +
  '      if(mt.error)h+=\'<div style="font-size:12px;color:#ffb4ab">\'+H(mt.error)+\'</div>\';if(mt.warning)h+=\'<div style="font-size:12px;color:#cbbcff">\'+H(mt.warning)+\'</div>\';' +
  '      h+=\'<div class="transfer-controls"><button class="btn-ghost" data-action="media-cancel" data-job="\'+H(mt.id)+\'" style="color:#ffb4ab;border-color:#93000a"><span class="material-symbols-outlined">close</span> \\u041e\\u0442\\u043c\\u0435\\u043d\\u0430</button></div></div>\';' +
  '    }document.getElementById("transfers-list").innerHTML=h;' +
  '  }).catch(function(){});' +
  '}' +
  'function loadDisk(){' +
  '  fetch("/api/fm/list?path=").then(function(r){return r.json();})' +
  '  .then(function(d){' +
  '    if(d.diskUsed!=null&&d.diskTotal!=null){' +
  '      var pct=Math.round(d.diskUsed/d.diskTotal*100);' +
  '      document.getElementById("disk-fill").style.width=pct+"%";' +
  '      document.getElementById("disk-label").textContent=fmtSize(d.diskUsed)+" / "+fmtSize(d.diskTotal);' +
  '      var mf=document.getElementById("mobile-disk-fill"),ml=document.getElementById("mobile-disk-label");' +
  '      if(mf)mf.style.width=pct+"%";' +
  '      if(ml)ml.textContent=fmtSize(d.diskUsed)+" / "+fmtSize(d.diskTotal);' +
  '    }' +
  '  }).catch(function(){});' +
  '}' +
  /* ── CLICK DELEGATION ── */
  'document.addEventListener("click",function(e){' +
  '  /* context menu item */\n' +
  '  var ctx=e.target.closest("[data-ctx]");' +
  '  if(ctx){' +
  '    var ca=ctx.dataset.ctx;' +
  '    hideCtxMenu();' +
  '    if(ca==="open")navigateTo(ctxFp);' +
  '    else if(ca==="download")window.location.href="/api/fm/download?path="+encodeURIComponent(ctxFp);' +
  '    else if(ca==="preview")openPreview(ctxFp,ctxName,ctxIsDir);' +
  '    else if(ca==="share")shareOne(ctxFp);' +
  '    else if(ca==="share-manage")openShareManager(ctxFp,ctxName);' +
  '    else if(ca==="rename")openRenameModal(ctxFp,ctxName,ctxIsDir);' +
  '    else if(ca==="delete")deleteItem(ctxFp,ctxName,ctxIsDir);' +
  '    else if(ca==="copypath"){navigator.clipboard&&navigator.clipboard.writeText(ctxFp).catch(function(){});}' +
  '    return;' +
  '  }' +
  '  if(!e.target.closest("#ctx-menu"))hideCtxMenu();' +
  '  /* action buttons */\n' +
  '  var el=e.target.closest("[data-action]");' +
  '  if(!el)return;' +
  '  var action=el.dataset.action;' +
  '  if(action.indexOf("mv-")===0){mediaViewerAction(action);return;}' +
  '  if(action==="focus-search"){var si=document.getElementById("search-inp");if(si){si.focus();si.scrollIntoView({block:"center",behavior:"smooth"});}return;}' +
  '  if(action==="item-menu"){e.preventDefault();e.stopPropagation();var r=el.getBoundingClientRect();showCtxMenu(r.right-190,r.bottom+6,el.dataset.fp,el.dataset.name,el.dataset.dir==="true");return;}' +
  '  if(el.classList&&el.classList.contains("bottom-nav-item")){document.querySelectorAll(".bottom-nav-item").forEach(function(x){x.classList.remove("active");});el.classList.add("active");}' +
  '  if(action==="navigate")navigateTo(el.dataset.fp||"");' +
  '  else if(action==="go-back")goBackPath();' +
  '  else if(action==="select-item"){toggleSelect(el.dataset.fp,el.dataset.name,el.dataset.dir==="true",el.checked);}' +
  '  else if(action==="select-all"){selectAllVisible(el.checked);}' +
  '  else if(action==="clear-selection"){clearSelection(true);}' +
  '  else if(action==="download-selected"){downloadSelected();}' +
  '  else if(action==="zip-selected"){zipSelected();}' +
  '  else if(action==="share-selected"){shareSelected();}' +
  '  else if(action==="delete-selected"){deleteSelected();}' +
  '  else if(action==="hide-upload-panel"){document.getElementById("upload-panel").style.display="none";}' +
  '  else if(action==="hide-toast"){hideToast();}' +
  '  else if(action==="copy-toast"){copyToast();}' +
  '  else if(action==="open-toast-qr"){openQrModal(toastUrl);}' +
  '  else if(action==="open-toast-link"){if(toastUrl)window.open(toastUrl,"_blank");}' +
  '  else if(action==="qr-link"){openQrModal(el.dataset.url);}' +
  '  else if(action==="close-qr"){closeQrModal();}' +
  '  else if(action==="close-share-manager"){closeShareManager();}' +
  '  else if(action==="sm-create"){createManagedShare();}' +
  '  else if(action==="sm-save"){saveManagedShare(el.dataset.token);}' +
  '  else if(action==="sm-revoke"){revokeManagedShare(el.dataset.token);}' +
  '  else if(action==="sm-copy"){copyPlain(el.dataset.url);}' +
  '  else if(action==="sm-qr"){openQrModal(el.dataset.url);}' +
  '  else if(action==="minimize-transfers"){transfersMinimized=true;localStorage.setItem("transfers-minimized","1");setTransfersUi(1);}' +
  '  else if(action==="restore-transfers"){transfersMinimized=false;localStorage.setItem("transfers-minimized","0");loadTransfers();}' +
  '  else if(action==="toggle-theme"){toggleTheme();}' +
  '  else if(action==="share-one"){shareOne(el.dataset.fp);}' +
  '  else if(action==="preview"){openPreview(el.dataset.fp,el.dataset.name,el.dataset.dir==="true");}' +
  '  else if(action==="open-url-modal"){openUrlModal();}' +
  '  else if(action==="dashboard-url-download"){addDashboardUrlDownload();}' +
  '  else if(action==="close-url-modal"){closeUrlModal();}' +
  '  else if(action==="confirm-url-download"){addUrlDownload();}' +
  '  else if(action==="close-share-modal"){closeShareModal();}' +
  '  else if(action==="confirm-share"){confirmShare();}' +
  '  else if(action==="close-preview"){closePreview();}' +
  '  else if(action==="fullscreen-preview"){openMediaViewer();}' +
  '  else if(action==="preview-prev"||action==="playlist-prev"){playSibling("prev",true);}' +
  '  else if(action==="preview-next"||action==="playlist-next"){playSibling("next",true);}' +
  '  else if(action==="filter-category"){activeFilter=el.dataset.filter;renderContent(lastEntries,lastBase);}' +
  '  else if(action==="set-accent"){var themeName=el.dataset.theme;localStorage.setItem("cloud-accent",themeName);applyAccentColor();document.querySelectorAll(".theme-card").forEach(function(x){var on=x.dataset.theme===themeName;x.classList.toggle("active",on);var i=x.querySelector(".material-symbols-outlined:last-child");if(i)i.textContent=on?"check_circle":"radio_button_unchecked";});}' +
  '  else if(action==="download-preview"){if(previewFp)window.location.href="/api/fm/download?path="+encodeURIComponent(previewFp);}' +
  '  else if(action==="share-preview"){if(previewFp)shareOne(previewFp);}' +
  '  else if(action==="delete-preview"){if(previewFp&&confirm("Удалить файл?"))fetch("/api/fm/delete",{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:previewFp,isDir:false})}).then(function(r){return r.json();}).then(function(d){if(d.ok){closePreview();refreshCurrent();}else alert(d.error||"Ошибка удаления");}).catch(function(){alert("Ошибка удаления");});}' +
  '  else if(action==="transfer-pause"){fetch("/api/downloads/"+encodeURIComponent(el.dataset.gid)+"/pause",{method:"POST"}).then(loadTransfers);}' +
  '  else if(action==="transfer-resume"){fetch("/api/downloads/"+encodeURIComponent(el.dataset.gid)+"/resume",{method:"POST"}).then(loadTransfers);}' +
  '  else if(action==="transfer-remove"){if(confirm("Убрать загрузку?"))fetch("/api/downloads/"+encodeURIComponent(el.dataset.gid),{method:"DELETE"}).then(loadTransfers);}' +
  '  else if(action==="media-cancel"){if(confirm("Отменить медиа-загрузку?"))fetch("/api/fm/media-jobs/"+encodeURIComponent(el.dataset.job),{method:"DELETE"}).then(loadTransfers);}' +
  '  else if(action==="nav-home"||action==="nav-dashboard"){loadDashboard();}' +
  '  else if(action==="nav-files"){navigateTo("");}' +
  '  else if(action==="nav-recent"){loadRecent();}' +
  '  else if(action==="nav-activity"){loadActivityLog();}' +
  '  else if(action==="nav-settings"){loadCloudSettings();}' +
  '  else if(action==="settings-save-retention"){saveCloudRetention();}' +
  '  else if(action==="settings-save-tg-limit"){saveCloudTgLimit();}' +
  '  else if(action==="settings-save-profile"){saveCloudProfile();}' +
  '  else if(action==="settings-speedtest"){runSpeedTest();}' +
  '  else if(action==="settings-notif"){requestCloudNotif();}' +
  '  else if(action==="settings-load-token"){loadCloudToken();}' +
  '  else if(action==="settings-copy-token"){copyCloudToken();}' +
  '  else if(action==="settings-reset-token"){resetCloudToken();}' +
  '  else if(action==="set-accent-hex"){var h=el.dataset.hex;if(h){localStorage.setItem("cloud-accent-hex",h);applyAccentColor();var inp=document.getElementById("accent-color-input");var lbl=document.getElementById("accent-hex-label");if(inp)inp.value=h;if(lbl)lbl.textContent=h;updateColorSwatches(h);}}' +
  '  else if(action==="settings-tg-connect"){connectTelegram();}' +
  '  else if(action==="settings-tg-unlink"){unlinkTelegram();}' +
  '  else if(action==="settings-change-password"){changeCloudPassword();}' +
  '  else if(action==="settings-add-user"){addCloudUser();}' +
  '  else if(action==="settings-delete-user"){deleteCloudUser(el.dataset.user);}' +
  '  else if(action==="retry-url"){var u=el.dataset.url;if(u){openUrlModal(u);}}' +
  '  else if(action==="show-history-error"){alert(el.dataset.error||"Ошибка загрузки");}' +
  '  else if(action==="view-list"){setView("list");}' +
  '  else if(action==="view-grid"){setView("grid");}' +
  '  else if(action==="mkdir")openMkdirModal();' +
  '  else if(action==="close-mkdir")closeMkdirModal();' +
  '  else if(action==="confirm-mkdir")createFolder();' +
  '  else if(action==="rename")openRenameModal(el.dataset.fp,el.dataset.name,el.dataset.dir==="true");' +
  '  else if(action==="close-rename")closeRenameModal();' +
  '  else if(action==="confirm-rename")doRename();' +
  '  else if(action==="delete")deleteItem(el.dataset.fp,el.dataset.name,el.dataset.dir==="true");' +
  '  else if(action==="upload-btn")document.getElementById("upload-input").click();' +
  '});' +
  /* ── CLICK on file row to open folder ── */
  'document.addEventListener("click",function(e){' +
  '  if(e.target.closest("[data-action]")||e.target.closest("[data-ctx]"))return;' +
  '  var row=e.target.closest("[data-fp][data-dir]");' +
  '  if(!row)return;' +
  '  if(row.dataset.dir==="true")navigateTo(row.dataset.fp);else openPreview(row.dataset.fp,row.dataset.name,false);' +
  '});' +
  /* ── CONTEXT MENU trigger ── */
  'document.addEventListener("contextmenu",function(e){' +
  '  var row=e.target.closest("[data-fp][data-name]");' +
  '  if(!row){hideCtxMenu();return;}' +
  '  e.preventDefault();' +
  '  showCtxMenu(e.clientX,e.clientY,row.dataset.fp,row.dataset.name,row.dataset.dir==="true");' +
  '});' +
  'document.addEventListener("scroll",hideCtxMenu,true);' +
  /* ── DRAG START ── */
  'document.addEventListener("dragstart",function(e){' +
  '  var row=e.target.closest("[data-fp][data-name]");' +
  '  if(!row)return;' +
  '  dragFp=row.dataset.fp;dragName=row.dataset.name;dragIsDir=row.dataset.dir==="true";dragEl=row;' +
  '  e.dataTransfer.effectAllowed="move";' +
  '  e.dataTransfer.setData("text/plain",dragFp);' +
  '  var sel=selectedList();' +
  '  var isMulti=sel.length>1&&!!selectedItems[dragFp];' +
  '  dragItems=isMulti?sel:null;' +
  '  if(isMulti){' +
  '    createDragGhost(e,sel);' +
  '    document.querySelectorAll("[data-fp]").forEach(function(el){if(selectedItems[el.dataset.fp])el.classList.add("dragging");});' +
  '  }else{' +
  '    setTimeout(function(){if(dragEl)dragEl.classList.add("dragging");},0);' +
  '  }' +
  '});' +
  /* ── DRAG END ── */
  'document.addEventListener("dragend",function(){' +
  '  document.querySelectorAll(".dragging").forEach(function(el){el.classList.remove("dragging");});' +
  '  dragEl=null;dragFp=null;dragItems=null;' +
  '  removeDragGhost();clearDragOver();' +
  '  document.getElementById("drop-zone").classList.remove("active");' +
  '});' +
  /* ── DRAG OVER ── */
  'document.addEventListener("dragover",function(e){' +
  '  /* internal move: drag over a folder */\n' +
  '  if(dragFp){' +
  '    var dropTarget=e.target.closest("[data-drop-path]");' +
  '    if(dropTarget){' +
  '      e.preventDefault();e.dataTransfer.dropEffect="move";' +
  '      clearDragOver();dropTarget.classList.add("drop-target");' +
  '      return;' +
  '    }' +
  '    var target=e.target.closest("[data-dir=\'true\'][data-fp]");' +
  '    if(target&&target.dataset.fp!==dragFp){' +
  '      e.preventDefault();e.dataTransfer.dropEffect="move";' +
  '      clearDragOver();target.classList.add("drag-over");' +
  '      return;' +
  '    }' +
  '    clearDragOver();' +
  '    return;' +
  '  }' +
  '  /* external files */\n' +
  '  if(e.dataTransfer.types&&Array.from(e.dataTransfer.types).includes("Files")){' +
  '    e.preventDefault();e.dataTransfer.dropEffect="copy";' +
  '    document.getElementById("drop-zone").classList.add("active");' +
  '  }' +
  '});' +
  /* ── DRAG LEAVE ── */
  'document.addEventListener("dragleave",function(e){' +
  '  if(!e.relatedTarget){' +
  '    clearDragOver();' +
  '    document.getElementById("drop-zone").classList.remove("active");' +
  '  }' +
  '});' +
  /* ── DROP ── */
  'document.addEventListener("drop",function(e){' +
  '  clearDragOver();' +
  '  document.getElementById("drop-zone").classList.remove("active");' +
  '  /* external file drop */\n' +
  '  if(!dragFp&&e.dataTransfer.files&&e.dataTransfer.files.length){' +
  '    e.preventDefault();' +
  '    uploadFiles(e.dataTransfer.files,activePath());' +
  '    return;' +
  '  }' +
  '  /* internal move */\n' +
  '  if(!dragFp)return;' +
  '  var destFp=null;' +
  '  var dropTarget=e.target.closest("[data-drop-path]");' +
  '  if(dropTarget){' +
  '    e.preventDefault();' +
  '    destFp=dropTarget.dataset.dropPath||"";' +
  '  }else{' +
  '    var target=e.target.closest("[data-dir=\'true\'][data-fp]");' +
  '    if(!target||target.dataset.fp===dragFp){dragFp=null;dragItems=null;return;}' +
  '    e.preventDefault();' +
  '    destFp=target.dataset.fp;' +
  '  }' +
  '  if(dragItems&&dragItems.length>1){' +
  '    var multiItems=dragItems;' +
  '    dragFp=null;dragItems=null;' +
  '    moveMultiTo(multiItems,destFp);' +
  '  }else{' +
  '    var moveFp=dragFp,moveName=dragName;' +
  '    dragFp=null;dragItems=null;' +
  '    moveItemTo(moveFp,moveName,destFp);' +
  '  }' +
  '});' +
  /* ── KEYBOARD ── */
  'document.addEventListener("keydown",function(e){' +
  '  if(e.key==="Escape"){hideCtxMenu();closeMkdirModal();closeRenameModal();closeUrlModal();closeShareModal();closeShareManager();closeQrModal();closeMediaViewer();closePreview();}  var mv=document.getElementById("media-viewer");  var isMvOpen=mv&&mv.classList.contains("open");  if(isMvOpen && previewKind==="image"){    if(e.key==="ArrowRight"){playSibling("next",true);}    else if(e.key==="ArrowLeft"){playSibling("prev",true);}  }' +
  '  if(e.key==="Enter"){' +
  '    if(document.getElementById("modal-mkdir").style.display!=="none")createFolder();' +
  '    else if(document.getElementById("modal-rename").style.display!=="none")doRename();' +
  '    else if(document.getElementById("modal-url").style.display!=="none")addUrlDownload();' +
  '    else if(document.getElementById("modal-share").style.display!=="none")confirmShare();' +
  '  }' +
  '});' +
  /* ── CLIPBOARD PASTE ── */
  'document.addEventListener("paste",function(e){' +
  '  var target=e.target;' +
  '  if(target.tagName==="INPUT"||target.tagName==="TEXTAREA"||target.isContentEditable)return;' +
  '  var items=(e.clipboardData||(e.originalEvent||{}).clipboardData||{}).items||[];' +
  '  var files=[];' +
  '  for(var i=0;i<items.length;i++){' +
  '    if(items[i].kind==="file"){' +
  '      var blob=items[i].getAsFile();' +
  '      if(blob){' +
  '        var name=blob.name;' +
  '        if(!name||name==="image.png"){' +
  '          var d=new Date();' +
  '          var ts=d.getFullYear()+""+String(d.getMonth()+1).padStart(2,"0")+""+String(d.getDate()).padStart(2,"0")+"_"+String(d.getHours()).padStart(2,"0")+""+String(d.getMinutes()).padStart(2,"0")+""+String(d.getSeconds()).padStart(2,"0");' +
  '          name="Screenshot_"+ts+".png";' +
  '        }' +
  '        try{' +
  '          var f=new File([blob],name,{type:blob.type});' +
  '          files.push(f);' +
  '        }catch(err){' +
  '          blob.name=name;files.push(blob);' +
  '        }' +
  '      }' +
  '    }' +
  '  }' +
  '  if(files.length){' +
  '    e.preventDefault();' +
  '    uploadFiles(files,activePath());' +
  '  }' +
  '});' +
  /* ── UPLOAD input ── */
  'document.getElementById("upload-input").addEventListener("change",function(){' +
  '  uploadFiles(this.files,activePath());this.value="";' +
  '});' +
  /* ── SEARCH ── */
  'var searchTimer;' +
  'document.getElementById("search-inp").addEventListener("input",function(){' +
  '  clearTimeout(searchTimer);var q=this.value;' +
  '  searchTimer=setTimeout(function(){doSearch(q);},400);' +
  '});' +
  'document.addEventListener("keydown",function(e){if(e.key==="Enter"&&document.activeElement&&["dash-url-inp","dash-name-inp","dash-url-inp-batch"].includes(document.activeElement.id)){if(document.activeElement.id==="dash-url-inp-batch"&&!e.ctrlKey)return;addDashboardUrlDownload();}});' +
  'window.addEventListener("beforeunload",function(e){if(uploadBusy){e.preventDefault();e.returnValue="";return "";}});' +
  '(function(){' +
  '  var resizer=document.getElementById("preview-resizer");' +
  '  var panel=document.getElementById("preview-panel");' +
  '  if(!resizer||!panel)return;' +
  '  var isDragging=false;' +
  '  resizer.addEventListener("mousedown",function(e){' +
  '    if(window.innerWidth<=768)return;' +
  '    isDragging=true;' +
  '    resizer.classList.add("dragging");' +
  '    document.body.style.cursor="col-resize";' +
  '    document.body.style.userSelect="none";' +
  '    e.preventDefault();' +
  '  });' +
  '  window.addEventListener("mousemove",function(e){' +
  '    if(!isDragging)return;' +
  '    var width=window.innerWidth-e.clientX;' +
  '    if(width<240)width=240;' +
  '    if(width>window.innerWidth*0.8)width=window.innerWidth*0.8;' +
  '    panel.style.width=width+"px";' +
  '    panel.style.maxWidth="none";' +
  '    window.dispatchEvent(new Event("resize"));' +
  '  });' +
  '  window.addEventListener("mouseup",function(){' +
  '    if(!isDragging)return;' +
  '    isDragging=false;' +
  '    resizer.classList.remove("dragging");' +
  '    document.body.style.cursor="";' +
  '    document.body.style.userSelect="";' +
  '    window.dispatchEvent(new Event("resize"));' +
  '  });' +
  '  resizer.addEventListener("dblclick",function(e){' +
  '    if(window.innerWidth<=768)return;' +
  '    panel.style.width="";' +
  '    panel.style.maxWidth="";' +
  '    window.dispatchEvent(new Event("resize"));' +
  '  });' +
  '})();' +
  'applyTheme();' +
  '(function(){var h=parseHash();if(h){if(h.type==="dashboard")loadDashboard();else if(h.type==="recent")loadRecent();else if(h.type==="activity")loadActivityLog();else if(h.type==="settings")loadCloudSettings();else navigateTo(h.path||"");return;}var saved=localStorage.getItem("fm-path");if(saved===null)loadDashboard();else if(saved==="__dashboard__")loadDashboard();else if(saved==="__recent__")loadRecent();else if(saved==="__activity__")loadActivityLog();else if(saved==="__settings__")loadCloudSettings();else navigateTo(saved||"");})();initSidebarPlayer();' +
  'loadDisk();' +
  'loadTransfers();' +
  'checkConnection(true);' +
  'setInterval(loadTransfers,5000);' +
  'setInterval(loadDisk,60000);' +
  'setInterval(function(){checkConnection(true);},15000);' +
  '</script>' +
  '</body></html>';
}