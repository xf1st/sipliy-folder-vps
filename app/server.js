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

const VT_API_KEY = '93c0c934a298f0f35b0f95be051de5b4e4ea7340fa3c7bb8fd5c1f572a13c2b8';
const SHARES_FILE = '/opt/vps-downloader/shares.json';
const MEDIA_JOBS_FILE = '/opt/vps-downloader/media-jobs.json';
const mediaProcesses = new Map();

function loadShares() {
  try { return JSON.parse(fs.readFileSync(SHARES_FILE, 'utf8')); }
  catch { return {}; }
}
function saveShares(s) {
  fs.writeFileSync(SHARES_FILE, JSON.stringify(s));
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

function loadTokens() {
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveTokens(t) { fs.writeFileSync(TOKENS_FILE, JSON.stringify(t)); }

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveSettings(s) { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s)); }

function getUserRetention(username) {
  const s = loadSettings();
  return (s[username] !== undefined) ? s[username] : 7;
}

const VT_API = 'https://www.virustotal.com/api/v3';

const app = express();
const PORT = 3000;
const SITE_VERSION = '2.4.4';
const ARIA2_URL = 'http://localhost:6800/jsonrpc';
const ARIA2_TOKEN = 'mySecretToken123';
const DOWNLOADS_ROOT = '/var/downloads';

const USERS_FILE = '/opt/vps-downloader/users.json';
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch {
    const def = { xf1st: { password: '78457845Xf!', label: 'Admin', isAdmin: true } };
    fs.writeFileSync(USERS_FILE, JSON.stringify(def, null, 2));
    return def;
  }
}
function saveUsers(u) { fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2)); }
function isAdmin(username) { const u = loadUsers(); return u[username] && u[username].isAdmin; }
function htmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true }, // 30 дней, обновляется при каждом Р В·Р В°Р С—росе
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
  fs.writeFileSync(MEDIA_JOBS_FILE, JSON.stringify(jobs, null, 2));
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
  const { username, password } = req.body;
  const users = loadUsers();
  const user = users[username];
  if (user && user.password === password) {
    req.session.user = username;
    req.session.save(() => res.redirect('/'));
    return;
  }
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
  exec('df -B1 /var/downloads', (err, stdout) => {
    if (err) return res.status(500).json({ error: err.message });
    const lines = stdout.trim().split('\n');
    const parts = lines[1].trim().split(/\s+/);
    const total = parseInt(parts[1]);
    const used  = parseInt(parts[2]);
    const avail = parseInt(parts[3]);
    const percent = Math.round(used / total * 100);
    res.json({ total: fmtBytes(total), used: fmtBytes(used), avail: fmtBytes(avail), percent });
  });
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
});

app.post('/api/upload-ext', extCors, authToken, (req, res) => {
  extUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file' });
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
      .map(name => { const s = fs.statSync(path.join(dir, name)); return { name, size: s.size, mtime: s.mtime, path: '/' + name }; })
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

// Версия расширения (без авторизации — для OTA проверки)
const EXT_VERSION = '2.4.4';
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

// Скачать файл через токен в query-параметре (chrome.downloads не умеет слать заголовки)
app.get('/api/ext-dl/:file', (req, res) => {
  const token = (req.query.t || '').trim();
  const tokens = loadTokens();
  const username = tokens[token];
  if (!username) return res.status(401).send('Unauthorized');
  const file = path.join(userDir(username), path.basename(req.params.file));
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
  // Сбрасываем токены удалённого пользователя
  const tokens = loadTokens();
  Object.keys(tokens).forEach(t => { if (tokens[t] === target) delete tokens[t]; });
  saveTokens(tokens);
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
  res.json({ retention: getUserRetention(req.session.user) });
});

app.post('/api/settings', auth, (req, res) => {
  const v = parseInt(req.body.retention);
  if (isNaN(v) || ![0, 1, 3, 7, 30].includes(v)) return res.status(400).json({ error: 'Invalid' });
  const s = loadSettings();
  s[req.session.user] = v;
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
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

app.post('/api/upload', auth, upload.array('files', 50), (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'Нет файлов' });
  res.json({ ok: true, files: req.files.map(f => ({ name: f.filename, size: f.size })) });
});

app.delete('/api/files/:file', auth, (req, res) => {
  const dir = userDir(req.session.user);
  const file = path.join(dir, path.basename(req.params.file));
  try { fs.unlinkSync(file); res.json({ ok: true }); }
  catch { res.status(404).json({ error: 'Not found' }); }
});

app.listen(PORT, () => console.log('Running on port ' + PORT));

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
  const args = ['-m', 'zipfile', '-c', archivePath].concat(picked.map(x => x.rel));
  execFile('python3', args, { cwd: userDir(username), timeout: 10 * 60 * 1000 }, err => {
    if (err) return cb(err);
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
  });
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
        return { name, isDir, size: isDir ? fmDirSize(p) : stat.size, mtime: stat.mtime, fileCount };
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
  try { fs.mkdirSync(full, { recursive: true }); res.json({ ok: true }); }
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
  try { fs.renameSync(from, to); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/fm/delete  body: { path }
app.delete('/api/fm/delete', auth, (req, res) => {
  const full = fmResolve(req.session.user, req.body.path || req.query.path || '');
  if (!full) return res.status(403).json({ error: 'Invalid path' });
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'Not found' });
  try {
    const stat = fs.statSync(full);
    if (stat.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
    else fs.unlinkSync(full);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/fm/move  body: { from, to }
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
  try { fs.renameSync(from, to); res.json({ ok: true }); }
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
        if (name.toLowerCase().includes(q)) results.push({ name, relPath: rel, isDir, size: isDir ? fmDirSize(full) : stat.size, mtime: stat.mtime });
        if (isDir) walk(full, rel);
      });
    } catch {}
  }
  walk(base, '');
  res.json({ entries: results.slice(0, 100) });
});

// GET /api/fm/download?path=
app.get('/api/fm/download', auth, (req, res) => {
  const full = fmResolve(req.session.user, req.query.path || '');
  if (!full || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return res.status(404).send('Not found');
  res.download(full, path.basename(full));
});

// GET /api/fm/preview?path=
app.get('/api/fm/preview', auth, (req, res) => {
  const full = fmResolve(req.session.user, req.query.path || '');
  if (!full || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return res.status(404).send('Not found');
  const ext = path.extname(full).toLowerCase();

  if (ext === '.exe') {
    const { exec } = require('child_process');
    const tmpFile = '/tmp/icon-' + Date.now() + '-' + Math.random().toString(36).substring(7) + '.ico';
    const safeFull = full.replace(/"/g, '\\"');
    const cmd = `NAME=$(wrestool -l -t 14 "${safeFull}" 2>/dev/null | head -n 1 | sed -E 's/.*--name=([^ ]+).*/\\1/'); if [ -n "$NAME" ]; then wrestool -x -t 14 --name="$NAME" "${safeFull}" > "${tmpFile}" 2>/dev/null; fi`;
    exec(cmd, (err) => {
      if (!fs.existsSync(tmpFile) || fs.statSync(tmpFile).size === 0) {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        return res.status(404).send('Icon not found');
      }
      res.sendFile(tmpFile, { headers: { 'Content-Type': 'image/x-icon' } }, () => {
        fs.unlinkSync(tmpFile);
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
      size: stat.isDirectory() ? fmDirSize(full) : stat.size,
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
  const dir = fmResolve(req.session.user, relPath);
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return res.status(403).json({ error: 'Invalid path' });
  ytDlpAvailable((available) => {
    if (!available) return res.status(500).json({ error: 'yt-dlp is not installed on server' });
    try {
      const job = startMediaJob({ username: req.session.user, url: dlUrl, dir, relPath, mode, filename });
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
  fmZipItems(req.session.user, req.body.items || [], (req.body.name || 'cloudspace.zip').trim(), (err, z) => {
    if (err) return res.status(400).json({ error: err.message });
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
    return res.json({ ok: true, token, url: '/share/' + token });
  }
  fmZipItems(req.session.user, picked.map(x => x.rel), 'cloudspace-share.zip', (err, z) => {
    if (err) return res.status(400).json({ error: err.message });
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
});
app.post('/api/fm/upload', auth, (req, res) => {
  fmUploader.array('files', 50)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'Нет файлов' });
    res.json({ ok: true, files: req.files.map(f => ({ name: f.filename, size: f.size })) });
  });
});

app.get('/cloud', auth, (req, res) => res.send(cloudPage(req.session.user)));

function runCleanup() {
  Object.keys(loadUsers()).forEach(function(username) {
    const retention = getUserRetention(username);
    if (retention === 0) return;
    const dir = path.join(DOWNLOADS_ROOT, username);
    if (!fs.existsSync(dir)) return;
    const cutoff = Date.now() - retention * 24 * 60 * 60 * 1000;
    try {
      fs.readdirSync(dir).forEach(function(name) {
        const file = path.join(dir, name);
        try { if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file); } catch {}
      });
    } catch {}
  });
}
setInterval(runCleanup, 60 * 60 * 1000);
runCleanup();

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
  '<link rel="preconnect" href="https://fonts.googleapis.com">' +
  '<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">' +
  '<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet">' +
  '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/plyr@3.7.8/dist/plyr.css">' +
  '<script src="https://cdn.jsdelivr.net/npm/plyr@3.7.8/dist/plyr.polyfilled.js"></script>' +
  '<script>window.addEventListener("load",function(){var s=document.createElement("span");s.className="material-symbols-outlined";s.textContent="settings";s.style.cssText="position:absolute;visibility:hidden;font-size:24px;max-width:none;width:auto";document.body.appendChild(s);if(s.offsetWidth>36)document.documentElement.classList.add("no-symbol-font");s.remove();});</script>' +
  '<style>' +
  '*{box-sizing:border-box}' +
  'body{font-family:Manrope,sans-serif;background:#131315;color:#e5e1e4;letter-spacing:0;}' +
  '.material-symbols-outlined{font-family:"Material Symbols Outlined";font-variation-settings:"FILL" 0,"wght" 500,"GRAD" 0,"opsz" 24;line-height:1;vertical-align:middle;display:inline-flex;align-items:center;justify-content:center;max-width:1.25em;overflow:hidden;white-space:nowrap;text-transform:none}' +
  '.no-symbol-font .material-symbols-outlined{font-size:0!important;width:1.25em;min-width:1.25em;color:transparent!important}' +
  'body.flex{display:flex}' +
  '.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1 1 0%}.items-center{align-items:center}.justify-center{justify-content:center}.justify-between{justify-content:space-between}.gap-2{gap:8px}.gap-3{gap:12px}.sticky{position:sticky}.top-0{top:0}.h-screen{height:100vh}.overflow-y-auto{overflow-y:auto}.px-4{padding-left:16px;padding-right:16px}.py-6{padding-top:24px;padding-bottom:24px}.mb-6{margin-bottom:24px}' +
  '::-webkit-scrollbar{width:6px;height:6px}' +
  '::-webkit-scrollbar-track{background:#1b1b1e}' +
  '::-webkit-scrollbar-thumb{background:#494454;border-radius:9999px}' +
  '::-webkit-scrollbar-thumb:hover{background:#958ea0}' +
  '.mobile-topbar,.mobile-bottom-nav{display:none}' +
  '.sidebar{background:#0e0e10;width:280px;min-height:100vh;flex-shrink:0}' +
  '.card{background:#1b1b1d;border:1px solid rgba(74,68,85,.7);border-radius:16px}' +
  '.btn-primary{background:#7c3aed;color:#fff;border-radius:9999px;padding:10px 20px;font-weight:700;font-size:14px;border:none;cursor:pointer;transition:opacity .2s,transform .2s,box-shadow .2s;min-height:44px}' +
  '.btn-primary:hover{opacity:.9;transform:translateY(-1px);box-shadow:0 10px 24px rgba(160,120,255,.24)}' +
  '.btn-ghost{background:#201f21;border:1px solid #4a4455;color:#e5e1e4;border-radius:9999px;padding:8px 14px;font-weight:700;font-size:13px;cursor:pointer;transition:background .2s,transform .2s,border-color .2s;min-height:40px}' +
  '.btn-ghost:hover{background:rgba(208,188,255,.1);border-color:#7f67b8;transform:translateY(-1px)}' +
  '.nav-item{display:flex;align-items:center;gap:12px;padding:10px 16px;border-radius:12px;cursor:pointer;color:#cbc3d7;font-size:14px;font-weight:500;transition:background .2s;text-decoration:none}' +
  '.nav-item:hover{background:rgba(208,188,255,.1);color:#e4e1e6}' +
  '.nav-item.active{background:rgba(208,188,255,.15);color:#d0bcff}' +
  '.breadcrumb-sep{color:#494454;margin:0 6px}' +
  '.file-row{display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:12px;cursor:pointer;transition:background .15s,border-color .15s,transform .15s;border-bottom:1px solid #1f1f22}' +
  '.file-row:last-child{border-bottom:none}' +
  '.file-row:hover{background:#2a2a2d;transform:translateX(2px)}' +
  '.file-row.selected{background:rgba(160,120,255,.14)}' +
  '.file-row.drag-over{background:rgba(160,120,255,.18)!important;outline:2px dashed #a078ff;outline-offset:-2px}' +
  '.file-row.dragging{opacity:.4}' +
  '.file-grid-item{background:#1b1b1d;border:1px solid rgba(74,68,85,.55);border-radius:16px;padding:16px 12px;display:flex;flex-direction:column;align-items:center;gap:8px;cursor:pointer;transition:border-color .15s,background .15s,transform .15s,box-shadow .15s;text-align:center;animation:popIn .18s ease both}' +
  '.file-grid-item:hover{background:#2a2a2d;border-color:#6d3bd7;transform:translateY(-3px);box-shadow:0 14px 28px rgba(0,0,0,.24)}' +
  '.file-grid-item.selected{background:rgba(160,120,255,.14);border-color:#a078ff}' +
  '.file-grid-item.drag-over{background:rgba(160,120,255,.18)!important;border-color:#a078ff;outline:2px dashed #a078ff;outline-offset:-2px}' +
  '.file-grid-item.dragging{opacity:.4}' +
  '.file-thumb{width:48px;height:48px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:#353437;color:#d2bbff;font-size:26px;overflow:hidden;flex:0 0 auto}' +
  '.file-thumb .material-symbols-outlined{font-size:28px;color:#d2bbff}' +
  '.file-thumb img{width:100%;height:100%;object-fit:cover}' +
  '.file-actions{display:flex;gap:4px;margin-top:auto;flex-wrap:wrap;justify-content:center;max-width:100%}' +
  '.file-actions .btn-ghost{padding:3px 7px!important;min-width:30px}' +
  '.item-menu-btn{width:40px;height:40px;min-height:40px;border-radius:9999px;padding:0;display:flex;align-items:center;justify-content:center;flex:0 0 auto}' +
  '.item-menu-btn .material-symbols-outlined{font-size:22px}' +
  '.drop-target{outline:2px dashed #a078ff!important;outline-offset:-3px;background:rgba(160,120,255,.16)!important;color:#d2bbff!important}' +
  '.transfer-row{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid #1f1f22}' +
  '.transfer-row:last-child{border-bottom:none}' +
  '.transfer-card{display:flex;flex-direction:column;gap:8px;padding:12px 0;border-bottom:1px solid #1f1f22}' +
  '.transfer-card:last-child{border-bottom:none}' +
  '.transfer-top{display:flex;align-items:center;gap:10px}' +
  '.transfer-name{flex:1;min-width:0;font-size:13px;font-weight:700;color:#e4e1e6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
  '.transfer-status{font-size:11px;font-weight:800;text-transform:uppercase;color:#d2bbff;background:rgba(124,58,237,.16);border-radius:9999px;padding:3px 8px}' +
  '.transfer-meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 12px;font-size:12px;color:#958ea0}' +
  '.transfer-controls{display:flex;gap:8px;flex-wrap:wrap}' +
  '.transfer-controls .btn-ghost{min-height:32px;padding:4px 10px;font-size:12px}' +
  '.progress-track{background:#2a2a2d;border:1px solid rgba(208,188,255,.14);border-radius:9999px;height:10px;overflow:hidden;flex:1;box-shadow:inset 0 0 0 1px rgba(0,0,0,.18)}' +
  '.progress-fill{height:100%;border-radius:9999px;background:linear-gradient(90deg,#a078ff,#6d3bd7);transition:width .4s}' +
  '.progress-fill.done{background:#10B981;box-shadow:0 0 8px rgba(16,185,129,.5)}' +
  '.transfer-card.is-error{border-color:#93000a;background:rgba(147,0,10,.06);padding-left:12px;padding-right:12px;border-radius:12px}' +
  '.transfer-card.is-active{border-color:#6d3bd7;background:rgba(109,59,215,.06);padding-left:12px;padding-right:12px;border-radius:12px}' +
  '.transfer-section-title{font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.06em;color:#958ea0;margin:4px 0}' +
  '#transfers-card{display:none;position:fixed;right:24px;bottom:24px;z-index:520;width:min(560px,calc(100vw - 48px));max-height:min(62vh,620px);overflow:auto;margin:0!important;padding:16px!important;box-shadow:0 18px 70px rgba(0,0,0,.5)}' +
  '#transfers-card.minimized{display:none!important}' +
  '#transfers-chip{display:none;position:fixed;right:24px;bottom:24px;z-index:521;align-items:center;gap:10px;background:#1f1f22;border:1px solid #6d3bd7;border-radius:9999px;padding:10px 14px;color:#e4e1e6;box-shadow:0 14px 46px rgba(0,0,0,.45);cursor:pointer}' +
  '#transfers-chip.active{display:flex}' +
  '.new-badge{display:inline-flex;align-items:center;margin-left:8px;border:1px solid rgba(16,185,129,.42);background:rgba(16,185,129,.14);color:#86efac;border-radius:9999px;padding:2px 7px;font-size:10px;font-weight:900;text-transform:uppercase}' +
  '.file-row.is-new,.file-grid-item.is-new{outline:2px solid rgba(16,185,129,.65)!important;outline-offset:-2px}' +
  '.history-row{display:grid;grid-template-columns:1fr 120px 90px 150px;gap:12px;align-items:center;padding:12px 14px;border-bottom:1px solid #1f1f22;background:#17171a}' +
  '.history-row:first-child{border-radius:12px 12px 0 0}' +
  '.history-row:last-child{border-bottom:none;border-radius:0 0 12px 12px}' +
  '.history-name{min-width:0;font-size:13px;font-weight:800;color:#e4e1e6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
  '.history-meta{font-size:12px;color:#958ea0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
  '.select-check{width:16px;height:16px;accent-color:#a078ff;cursor:pointer;flex:0 0 auto}' +
  '#selection-bar{display:none;align-items:center;gap:10px;padding:10px 24px;border-bottom:1px solid #1f1f22;background:#17171a;flex-shrink:0}' +
  '#upload-panel{display:none;position:fixed;right:24px;bottom:24px;z-index:350;width:min(420px,calc(100vw - 48px));background:#1f1f22;border:1px solid #494454;border-radius:14px;padding:14px;box-shadow:0 16px 50px rgba(0,0,0,.55);animation:slideUp .22s ease both}' +
  '#toast{display:none;position:fixed;right:24px;bottom:24px;z-index:650;width:min(380px,calc(100vw - 48px));background:#1f1f22;border:1px solid #6d3bd7;border-radius:12px;padding:10px 14px;box-shadow:0 8px 32px rgba(0,0,0,.55);animation:slideUp .18s ease both}' +
  '#connection-pill{display:none;position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:700;align-items:center;gap:8px;background:rgba(31,31,34,.94);border:1px solid #6d3bd7;border-radius:9999px;padding:8px 12px;color:#e4e1e6;font-size:12px;font-weight:800;box-shadow:0 10px 34px rgba(0,0,0,.42);backdrop-filter:blur(16px)}' +
  '#connection-pill.offline{display:flex;border-color:#93000a;color:#ffdad6}' +
  '#connection-pill.checking{display:flex;border-color:#6650a4;color:#d2bbff}' +
  '#connection-pill .dot{width:8px;height:8px;border-radius:9999px;background:#a078ff;box-shadow:0 0 12px rgba(160,120,255,.8)}' +
  '#connection-pill.offline .dot{background:#ff5449;box-shadow:0 0 12px rgba(255,84,73,.8)}' +
  '.speed-result{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:12px}' +
  '.speed-metric{border:1px solid #353437;border-radius:14px;padding:10px;background:#17171a;min-width:0}' +
  '.speed-metric b{display:block;color:#fff;font-size:18px;line-height:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
  '.speed-metric span{display:block;color:#958ea0;font-size:11px;margin-top:3px}' +
  '.preview-panel{display:none;width:380px;max-width:38vw;border-left:1px solid #1f1f22;background:#151518;flex-shrink:0;flex-direction:column;overflow:hidden;transform-origin:right center}' +
  '.preview-panel.open{display:flex;animation:panelIn .22s cubic-bezier(.2,.8,.2,1) both}' +
  '.preview-head{display:flex;align-items:center;gap:6px;padding:10px 14px;border-bottom:1px solid #1f1f22;flex-shrink:0}' +
  '.preview-body{padding:14px;overflow:auto;flex:1;min-height:0}' +
  '.preview-body.media-preview{display:flex;align-items:center;justify-content:center;background:#0e0e10}' +
  '.preview-media{max-width:100%;max-height:72vh;border-radius:12px;object-fit:contain;display:block}' +
  ':root{--plyr-color-main:#a078ff}' +
  '.mv-stage .plyr,.preview-media-wrap .plyr{width:auto;max-width:100%;border-radius:14px;background:#000;box-shadow:0 24px 90px rgba(0,0,0,.38);overflow:hidden}' +
  '.mv-stage .plyr{max-height:100%;height:auto}' +
  '.mv-stage .plyr video,.preview-media-wrap .plyr video{width:100%;height:100%;max-width:100%;max-height:72vh;object-fit:contain}' +
  '.mv-stage .plyr__video-wrapper,.preview-media-wrap .plyr__video-wrapper{background:#000!important;aspect-ratio:auto!important}' +
  '.preview-media-wrap .plyr audio{width:100%}' +
  '.plyr--full-ui input[type=range]{color:#a078ff}' +
  '.preview-media-wrap{width:100%;min-height:260px;display:flex;align-items:center;justify-content:center}' +
  '.preview-media-wrap:fullscreen{background:#050506;padding:24px}' +
  '.preview-media-wrap:fullscreen .preview-media{max-width:100vw;max-height:100vh}' +
  '.doc-preview{font-size:13px;line-height:1.55;color:#e4e1e6;background:#17171a;border:1px solid #353437;border-radius:14px;padding:14px;overflow:auto}' +
  '.doc-preview h1,.doc-preview h2,.doc-preview h3{margin:0 0 10px;color:#fff;line-height:1.2}' +
  '.doc-preview table,.archive-table{width:100%;border-collapse:collapse;font-size:12px}' +
  '.doc-preview td,.doc-preview th,.archive-table td,.archive-table th{border-bottom:1px solid #353437;padding:8px;text-align:left;vertical-align:top}' +
  '.doc-tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}' +
  '.doc-tab{border:1px solid #494454;background:#1f1f22;color:#e4e1e6;border-radius:999px;padding:6px 10px;font-weight:800;font-size:12px;cursor:pointer}' +
  '.archive-path{max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e4e1e6}' +
  '.archive-dir{color:#d2bbff;font-weight:800}' +
  '.media-viewer{position:fixed;inset:0;z-index:900;background:rgba(5,5,7,.96);display:none;flex-direction:column;color:#fff}' +
  '.media-viewer.open{display:flex;animation:viewerIn .2s cubic-bezier(.2,.8,.2,1) both}' +
  '.mv-top{height:64px;display:flex;align-items:center;gap:10px;padding:0 18px;border-bottom:1px solid rgba(255,255,255,.08);background:rgba(20,20,24,.72);backdrop-filter:blur(18px)}' +
  '.mv-title{flex:1;min-width:0;font-size:15px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
  '.mv-icon{width:42px;height:42px;border-radius:9999px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.07);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer}' +
  '.mv-icon:hover{background:rgba(160,120,255,.22);border-color:#a078ff}' +
  '.mv-stage{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:18px;overflow:hidden;position:relative;background:radial-gradient(circle at 50% 50%,rgba(160,120,255,.08),transparent 42%)}' +
  '.mv-stage img,.mv-stage video{max-width:100%;max-height:100%;object-fit:contain;border-radius:14px;box-shadow:0 24px 90px rgba(0,0,0,.55)}' +
  '.mv-stage audio{width:min(720px,92vw)}' +
  '.mv-bottom{min-height:72px;display:flex;align-items:center;gap:12px;padding:12px 18px;border-top:1px solid rgba(255,255,255,.08);background:rgba(20,20,24,.72);backdrop-filter:blur(18px)}' +
  '.mv-seek{flex:1;accent-color:#a078ff}' +
  '.mv-time{font-size:12px;color:#cbc3d7;min-width:96px;text-align:center}' +
  '.mv-range{width:100px;accent-color:#a078ff}' +
  '.mv-center-play{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(.94);width:86px;height:86px;border-radius:9999px;border:1px solid rgba(255,255,255,.28);background:rgba(20,20,24,.62);backdrop-filter:blur(18px);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 18px 60px rgba(0,0,0,.42);transition:opacity .18s,transform .18s}' +
  '.mv-center-play.hidden{opacity:0;pointer-events:none;transform:translate(-50%,-50%) scale(.82)}' +
  '.mv-center-play .material-symbols-outlined{font-size:48px}' +
  '.mv-select{height:38px;border-radius:9999px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.07);color:#fff;padding:0 10px;font:700 12px Manrope,sans-serif;outline:none}' +
  '.mv-select option{background:#16161a;color:#fff}' +
  '.mv-hint{position:absolute;left:50%;top:18px;transform:translateX(-50%);background:rgba(20,20,24,.72);border:1px solid rgba(255,255,255,.14);border-radius:9999px;padding:7px 12px;color:#cbc3d7;font-size:12px;opacity:0;pointer-events:none;transition:opacity .18s}' +
  '.mv-hint.show{opacity:1}' +
  '#preview-info{padding:14px 16px;border-top:1px solid #1f1f22;flex-shrink:0;max-height:260px;overflow-y:auto;background:#121215}' +
  '.meta-row{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;padding:5px 0;border-bottom:1px solid #252528;font-size:12px}' +
  '.meta-row:last-child{border-bottom:none}' +
  '.meta-lbl{color:#494454;flex-shrink:0;padding-top:1px}' +
  '.meta-val{color:#cbc3d7;font-weight:500;text-align:right;word-break:break-all}' +
  '.dir-name{color:#d0bcff}' +
  '.file-name{color:#e4e1e6}' +
  '.upload-file{font-size:12px;color:#cbc3d7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
  '.modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:50;display:flex;align-items:center;justify-content:center}' +
  '#modal-qr{z-index:120!important}' +
  '#modal-qr .modal{z-index:121}' +
  '.modal{background:#1f1f22;border:1px solid #494454;border-radius:16px;padding:24px;min-width:360px;max-width:90vw;animation:popIn .18s ease both}' +
  '.inp{background:#0e0e11;border:1px solid #494454;border-radius:8px;color:#e4e1e6;padding:8px 14px;font-size:14px;width:100%;outline:none;font-family:Manrope,sans-serif}' +
  '.inp:focus{border-color:#d0bcff;box-shadow:0 0 0 3px rgba(208,188,255,.15)}' +
  '.disk-bar{background:#2a2a2d;border-radius:9999px;height:8px;overflow:hidden}' +
  '.disk-fill{height:100%;border-radius:9999px;background:linear-gradient(90deg,#a078ff,#6d3bd7)}' +
  'body.light{background:#f0ecfa;color:#17151c}' +
  'body.light .sidebar{background:#fff;border-right:1px solid #e2d9f3}' +
  'body.light .sidebar [style*="color:#e4e1e6"]{color:#17151c!important}' +
  'body.light .sidebar [style*="color:#958ea0"]{color:#7b6f93!important}' +
  'body.light .sidebar [style*="color:#494454"]{color:#4a3b6e!important}' +
  'body.light .nav-item{color:#4a3b6e}' +
  'body.light .nav-item:hover{background:#ede5ff;color:#6d3bd7}' +
  'body.light .nav-item.active{background:#e8e0ff;color:#6d3bd7}' +
  'body.light #main-area{background:#f6f3ff!important}' +
  'body.light #main-area>div:first-child{background:#fff!important;border-bottom-color:#e2d9f3!important}' +
  'body.light #main-area>div:nth-child(2){background:#f1ecfb!important;border-bottom-color:#d8cdec!important}' +
  'body.light #selection-bar{background:#ede5ff;border-bottom-color:#e2d9f3;color:#17151c}' +
  'body.light #file-scroll{background:#f0ecfa}' +
  'body.light .card{background:#fff;border-color:#e2d9f3;color:#17151c}' +
  'body.light .transfer-row{border-bottom-color:#e2d9f3}' +
  'body.light .transfer-card{border-bottom-color:#e2d9f3}' +
  'body.light .transfer-name{color:#17151c}' +
  'body.light .transfer-status{background:#ede5ff;color:#6d3bd7}' +
  'body.light .transfer-meta{color:#7b6f93}' +
  'body.light .progress-track{background:#e2d9f3}' +
  'body.light #transfers-card,body.light #transfers-chip{background:#fff;border-color:#a078ff;color:#17151c}' +
  'body.light .history-row{background:#fff;border-bottom-color:#e2d9f3}' +
  'body.light .history-name{color:#17151c}' +
  'body.light .history-meta{color:#7b6f93}' +
  'body.light .file-row{background:#fff!important;border-color:#d8cdec!important;border-bottom-color:#ede5ff;color:#17151c}' +
  'body.light .file-row:hover{background:#f7f2ff!important}' +
  'body.light .file-row.selected{background:#e0d5ff}' +
  'body.light .file-thumb{background:#ede5ff}' +
  'body.light .dir-name{color:#6d3bd7}' +
  'body.light .file-name{color:#17151c}' +
  'body.light .file-grid-item{background:#fff!important;border-color:#d8cdec!important;color:#17151c!important}' +
  'body.light .file-grid-item:hover{background:#f7f2ff!important;border-color:#a078ff!important}' +
  'body.light .file-grid-item.selected{background:#e8e0ff!important;border-color:#7c4dff!important}' +
  'body.light .file-grid-item [style*="color:#e4e1e6"],body.light .file-row [style*="color:#e4e1e6"]{color:#17151c!important}' +
  'body.light .file-grid-item [style*="color:#d0bcff"],body.light .file-row [style*="color:#d0bcff"]{color:#6d3bd7!important}' +
  'body.light .modal{background:#fff;border-color:#e2d9f3;color:#17151c}' +
  'body.light #upload-panel{background:#fff;border-color:#e2d9f3}' +
  'body.light #toast{background:#fff;border-color:#a078ff;color:#17151c}' +
  'body.light #connection-pill{background:rgba(255,255,255,.94);color:#17151c}' +
  'body.light .speed-metric{background:#faf8ff;border-color:#e2d9f3}' +
  'body.light .speed-metric b{color:#17151c}' +
  'body.light .preview-panel{background:#fff;border-left-color:#e2d9f3}' +
  'body.light .preview-head{border-bottom-color:#e2d9f3}' +
  'body.light #preview-title{color:#17151c}' +
  'body.light #preview-info{background:#faf8ff;border-top-color:#e2d9f3}' +
  'body.light .doc-preview{background:#fff;color:#17151c;border-color:#e2d9f3}' +
  'body.light .doc-preview h1,body.light .doc-preview h2,body.light .doc-preview h3{color:#17151c}' +
  'body.light .doc-preview td,body.light .doc-preview th,body.light .archive-table td,body.light .archive-table th{border-bottom-color:#e2d9f3}' +
  'body.light .doc-tab{background:#faf8ff;border-color:#e2d9f3;color:#17151c}' +
  'body.light .archive-path{color:#17151c}' +
  'body.light .meta-row{border-bottom-color:#e8e0f4}' +
  'body.light .meta-lbl{color:#9b91b4}' +
  'body.light .meta-val{color:#17151c}' +
  'body.light .preview-body{color:#17151c}' +
  'body.light .breadcrumb-sep{color:#c9bfe0}' +
  'body.light .disk-bar{background:#e2d9f3}' +
  'body.light #disk-label{color:#4a3b6e}' +
  'body.light .inp{background:#faf8ff;color:#17151c;border-color:#c9bfe0}' +
  'body.light .inp:focus{border-color:#a078ff}' +
  'body.light .btn-ghost{color:#4a3b6e;border-color:#c0b3d8;background:#fff}' +
  'body.light .btn-ghost:hover{background:#ede5ff;border-color:#a078ff;color:#6d3bd7}' +
  'body.light .btn-primary{background:#7c3aed!important;color:#fff!important}' +
  'body.light .mobile-actions button{background:#fff!important;border-color:#c0b3d8!important;color:#4a3b6e!important}' +
  'body.light .mobile-topbar,body.light .mobile-bottom-nav{background:rgba(255,255,255,.88)!important;border-color:#e2d9f3!important}' +
  'body.light .mobile-brand{color:#17151c!important;text-shadow:none!important}' +
  'body.light .mobile-avatar{background:#ede5ff!important;border-color:#d8cdec!important;color:#6d3bd7!important}' +
  'body.light #ctx-menu{background:#fff!important;border-color:#d8cdec!important;box-shadow:0 12px 40px rgba(50,34,80,.18)!important}' +
  'body.light .ctx-item{color:#2d2440!important}' +
  'body.light .ctx-item:hover{background:#ede5ff!important;color:#6d3bd7!important}' +
  'body.light .ctx-sep{background:#e8e0f4!important}' +
  'body.light #file-area{color:#17151c}' +
  /* context menu */
  '#ctx-menu{position:fixed;z-index:500;background:#1f1f22;border:1px solid #494454;border-radius:10px;padding:4px;min-width:190px;box-shadow:0 12px 40px rgba(0,0,0,.7);display:none;transform-origin:top left}' +
  '#ctx-menu.open{animation:menuIn .14s cubic-bezier(.2,.8,.2,1) both}' +
  '.ctx-item{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500;color:#e4e1e6;transition:background .12s}' +
  '.ctx-item:hover{background:rgba(208,188,255,.15);color:#d0bcff}' +
  '.ctx-item.danger{color:#ffb4ab}' +
  '.ctx-item.danger:hover{background:rgba(255,180,171,.1);color:#ff8a80}' +
  '.ctx-sep{height:1px;background:#353438;margin:3px 6px}' +
  /* drop zone overlay */
  '#drop-zone{position:fixed;inset:0;z-index:300;pointer-events:none;display:none;align-items:center;justify-content:center;flex-direction:column;gap:12px;background:rgba(109,59,215,.1);border:3px dashed #a078ff;border-radius:0}' +
  '#drop-zone.active{display:flex}' +
  '@keyframes popIn{from{opacity:0;transform:scale(.98) translateY(6px)}to{opacity:1;transform:scale(1) translateY(0)}}' +
  '@keyframes slideUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}' +
  '@keyframes panelIn{from{opacity:0;transform:translateX(18px) scale(.985)}to{opacity:1;transform:translateX(0) scale(1)}}' +
  '@keyframes menuIn{from{opacity:0;transform:translateY(-4px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}' +
  '@keyframes viewerIn{from{opacity:0;transform:scale(.992)}to{opacity:1;transform:scale(1)}}' +
  '@media (max-width:768px){' +
  'body{display:block!important;min-height:100dvh;overflow-x:hidden;padding:0 0 96px;background:#131315}' +
  '.mobile-topbar{display:flex;position:sticky;top:0;z-index:60;height:64px;align-items:center;justify-content:space-between;padding:0 20px;background:rgba(14,14,16,.86);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);border-bottom:1px solid rgba(53,52,55,.65)}' +
  '.mobile-brand{font-size:28px;line-height:34px;font-weight:800;color:#fff;letter-spacing:0;text-shadow:0 2px 12px rgba(0,0,0,.45)}' +
  '.mobile-avatar{width:36px;height:36px;border-radius:9999px;background:#353437;border:1px solid #4a4455;display:flex;align-items:center;justify-content:center;color:#d2bbff}' +
  '.mobile-icon-btn{width:44px;height:44px;border:0;border-radius:9999px;background:transparent;color:#8b5cf6;display:flex;align-items:center;justify-content:center}' +
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
  '#search-inp{width:100%!important;height:58px;border-radius:9999px!important;background:#2a2a2c!important;border:1px solid #4a4455!important;color:#e5e1e4!important;font-size:16px!important;padding-left:54px!important}' +
  '#search-inp::placeholder{color:#ccc3d8}' +
  '.mobile-toolbar>div[style*="position:relative"] span{left:20px!important;color:#ccc3d8!important}' +
  '.mobile-toolbar [data-action="upload-btn"]{display:flex!important;width:64px!important;height:64px!important;padding:0!important;align-items:center;justify-content:center;box-shadow:0 18px 30px rgba(124,58,237,.28);font-size:0;flex:0 0 auto}' +
  '.mobile-toolbar [data-action="view-list"],.mobile-toolbar [data-action="view-grid"],.mobile-toolbar [data-action="toggle-theme"]{width:48px!important;height:48px!important;min-height:48px!important;padding:0!important;align-items:center;justify-content:center;flex:0 0 auto}' +
  '.mobile-toolbar [data-action="toggle-theme"]{font-size:0!important}' +
  '.mobile-toolbar [data-action="toggle-theme"]::before{content:"contrast";font-family:"Material Symbols Outlined";font-size:26px}' +
  '.mobile-toolbar [data-action="upload-btn"]::before{content:"upload";font-family:"Material Symbols Outlined";font-size:34px;font-variation-settings:"FILL" 1,"wght" 700,"GRAD" 0,"opsz" 32}' +
  '.mobile-actions{display:flex!important;padding:0 20px 28px!important;gap:10px!important;overflow-x:auto;border-bottom:0!important;background:transparent!important}' +
  '.mobile-actions button{white-space:nowrap;min-height:44px;background:#201f21;border-color:#353437;color:#e5e1e4}' +
  '#mobile-storage{display:block!important;margin:0 20px 34px!important;padding:20px 28px!important}' +
  '#mobile-storage .disk-bar{height:8px;background:#201f21}' +
  '#selection-bar{position:sticky;top:64px;z-index:45;margin:0 20px 14px;padding:12px!important;flex-wrap:wrap;border:1px solid rgba(74,68,85,.65);border-radius:16px;background:#1b1b1d}' +
  '#file-scroll{padding:0 20px 20px!important;overflow:visible!important}' +
  '#file-area{display:block}' +
  '#file-area>div[style*="background:#1b1b1e"]{background:transparent!important;border:0!important;border-radius:0!important;overflow:visible!important;display:flex!important;flex-direction:column!important;gap:14px!important}' +
  '.file-row:first-child{display:none!important}' +
  '.file-row{min-height:80px;gap:14px!important;padding:16px 22px!important;background:#0e0e10!important;border:1px solid rgba(31,31,34,.65)!important;border-radius:18px!important;box-shadow:none;transform:none!important}' +
  '.file-row.selected{border-color:#7c3aed!important;box-shadow:0 0 0 2px rgba(124,58,237,.18);background:#1b1427!important}' +
  '.file-row>div:nth-child(4),.file-row>div:nth-child(5){display:none!important}' +
  '.file-row>div:nth-child(3){min-width:0;font-size:18px!important;line-height:24px!important;font-weight:700!important;color:#e5e1e4!important;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
  '.file-row>div:nth-child(3)::after{content:attr(data-meta);display:block;font-size:14px;line-height:20px;color:#ccc3d8;font-weight:600;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
  '.file-row>div:last-child{width:auto!important;flex-shrink:0}' +
  '.file-actions{gap:6px!important;justify-content:flex-end!important}' +
  '.file-actions .btn-ghost{width:34px;height:34px;min-height:34px;padding:0!important;font-size:0!important;border:0!important;background:transparent!important;color:#ccc3d8!important}' +
  '#file-area>div[style*="grid-template-columns"]{grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:22px!important}' +
  '.file-grid-item{min-height:144px;padding:18px 14px!important;align-items:flex-start!important;text-align:left!important;background:#1b1b1d!important;border-radius:18px!important}' +
  '.card{margin:0 20px 24px!important;padding:20px!important;border-radius:18px!important}' +
  '.mobile-bottom-nav{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:55;height:88px;align-items:center;justify-content:space-around;padding:8px 18px calc(8px + env(safe-area-inset-bottom));background:rgba(14,14,16,.88);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-top:1px solid rgba(53,52,55,.7)}' +
  '.bottom-nav-item{min-width:68px;height:64px;border:0;background:transparent;color:#8d8994;border-radius:22px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;font-size:12px;font-weight:800}' +
  '.bottom-nav-item.active{background:#211734;color:#d2bbff}' +
  '.bottom-nav-item .material-symbols-outlined{font-size:30px}' +
  '#upload-panel{left:20px!important;right:20px!important;bottom:104px!important;width:auto!important;border-radius:18px!important}' +
  '#toast{left:20px!important;right:20px!important;bottom:24px!important;top:auto!important;width:auto!important}' +
  '#transfers-card{left:20px!important;right:20px!important;bottom:104px!important;width:auto!important;max-height:50vh}' +
  '#transfers-chip{right:20px!important;bottom:104px!important}' +
  '.preview-panel{position:fixed!important;left:0;right:0;bottom:0;z-index:70;width:100%!important;max-width:none!important;max-height:72dvh;border-left:0;border-top:1px solid #353437;border-radius:22px 22px 0 0;background:#1b1b1d}' +
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
  '.modal{width:100%!important;max-width:none!important;max-height:86dvh!important;overflow:auto!important;padding:18px!important;border-radius:22px 22px 12px 12px!important}' +
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
  '.modal{min-width:0!important;width:100%!important;padding:18px!important;border-radius:22px 22px 12px 12px!important}' +
  '}' +
  '</style>' +
  '</head>' +
  '<body class="flex">' +

  '<header class="mobile-topbar">' +
  '<div class="mobile-avatar"><span class="material-symbols-outlined">person</span></div>' +
  '<div class="mobile-brand">CloudSpace</div>' +
  '<button class="mobile-icon-btn" data-action="focus-search" title="Поиск"><span class="material-symbols-outlined">search</span></button>' +
  '</header>' +

  /* ── SIDEBAR ── */
  '<aside class="sidebar flex flex-col py-6 px-4 gap-2 sticky top-0 h-screen overflow-y-auto">' +
  '<div class="flex items-center gap-3 px-2 mb-6">' +
  '<div style="background:linear-gradient(135deg,#a078ff,#6d3bd7);border-radius:10px;width:36px;height:36px;display:flex;align-items:center;justify-content:center;font-size:18px;"><span class="material-symbols-outlined">cloud</span></div>' +
  '<div><div style="font-weight:700;font-size:16px;color:#e4e1e6">CloudSpace</div>' +
  '<div style="font-size:12px;color:#958ea0">' + safeUsername + '</div></div>' +
  '</div>' +
  '<a href="/" class="nav-item"><span class="material-symbols-outlined">arrow_back</span><span>Главная</span></a>' +
  '<div style="font-size:11px;font-weight:600;letter-spacing:.05em;color:#494454;text-transform:uppercase;padding:8px 4px 4px">Навигация</div>' +
  '<div class="nav-item active" data-action="nav-dashboard"><span class="material-symbols-outlined">dashboard</span><span>Главная</span></div>' +
  '<div class="nav-item" data-action="nav-files"><span class="material-symbols-outlined">folder</span><span>Мои файлы</span></div>' +
  '<div class="nav-item" data-action="nav-recent"><span class="material-symbols-outlined">schedule</span><span>Недавние</span></div>' +
  '<div class="nav-item" data-action="nav-url-history"><span class="material-symbols-outlined">history</span><span>История URL</span></div>' +
  '<div class="nav-item" data-action="nav-settings"><span class="material-symbols-outlined">settings</span><span>Настройки</span></div>' +
  '<div style="flex:1"></div>' +
  '<div class="profile-card card" style="margin:0;padding:14px;background:linear-gradient(180deg,rgba(160,120,255,.12),rgba(27,27,29,.92));border-color:rgba(160,120,255,.32)">' +
  '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">' +
  '<div id="profile-avatar-sidebar" style="width:38px;height:38px;border-radius:14px;background:linear-gradient(135deg,#a078ff,#6d3bd7);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:900;font-size:16px;flex:0 0 auto">' + safeProfileInitial + '</div>' +
  '<div style="min-width:0;flex:1"><div id="profile-label-sidebar" style="font-size:14px;font-weight:900;color:#e4e1e6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + safeProfileLabel + '</div><div id="profile-meta-sidebar" style="font-size:11px;color:#958ea0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">@' + safeUsername + ' &middot; ' + safeProfileRole + '</div></div>' +
  '<button class="btn-ghost" data-action="nav-settings" title="Профиль" style="width:34px;height:34px;min-height:34px;padding:0;display:flex;align-items:center;justify-content:center"><span class="material-symbols-outlined" style="font-size:20px">manage_accounts</span></button>' +
  '</div>' +
  '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;padding:7px 9px;border:1px solid rgba(160,120,255,.22);border-radius:10px;background:rgba(14,14,16,.38)"><span style="font-size:10px;color:#958ea0;text-transform:uppercase;letter-spacing:.08em;font-weight:900">Версия сайта</span><span style="font-size:11px;color:#d2bbff;font-weight:900">v' + SITE_VERSION + '</span></div>' +
  '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px"><span style="font-size:11px;color:#958ea0">Диск</span><span style="font-size:11px;color:#cbc3d7" id="disk-label">Загрузка...</span></div>' +
  '<div class="disk-bar"><div class="disk-fill" id="disk-fill" style="width:0%"></div></div>' +
  '</div>' +
  '</aside>' +

  /* ── MAIN ── */
  '<main id="main-area" class="flex-1 flex flex-col" style="min-width:0">' +
  '<div class="desktop-toolbar mobile-toolbar" style="background:#0e0e11;border-bottom:1px solid #1f1f22;padding:12px 24px;display:flex;align-items:center;gap:16px;flex-shrink:0">' +
  '<button id="go-back-btn" class="btn-ghost" data-action="go-back" data-drop-path="" title="Назад" style="padding:6px 10px"><span class="material-symbols-outlined">arrow_back</span></button>' +
  '<div id="breadcrumb" style="flex:1;display:flex;align-items:center;flex-wrap:wrap;font-size:14px;color:#cbc3d7"></div>' +
  '<div style="position:relative">' +
  '<input id="search-inp" class="inp" placeholder="Search files, folders..." style="width:200px;padding-left:32px">' +
  '<span class="material-symbols-outlined" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:#958ea0">search</span>' +
  '</div>' +
  '<button class="btn-ghost" data-action="view-list" title="Список"><span class="material-symbols-outlined">view_list</span></button>' +
  '<button class="btn-ghost" data-action="view-grid" title="Сетка"><span class="material-symbols-outlined">grid_view</span></button>' +
  '<button class="btn-ghost" data-action="toggle-theme" title="Theme">Theme</button>' +
  '<button class="btn-primary" data-action="upload-btn">Загрузить</button>' +
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
  '<button class="bottom-nav-item active" data-action="nav-dashboard"><span class="material-symbols-outlined">home</span><span>Home</span></button>' +
  '<button class="bottom-nav-item" data-action="nav-files"><span class="material-symbols-outlined">folder</span><span>Files</span></button>' +
  '<button class="bottom-nav-item" data-action="nav-recent"><span class="material-symbols-outlined">schedule</span><span>Recent</span></button>' +
  '<button class="bottom-nav-item" data-action="nav-url-history"><span class="material-symbols-outlined">history</span><span>URL</span></button>' +
  '<button class="bottom-nav-item" data-action="nav-settings"><span class="material-symbols-outlined">settings</span><span>Settings</span></button>' +
  '<button class="bottom-nav-item" data-action="upload-btn"><span class="material-symbols-outlined">upload</span><span>Upload</span></button>' +
  '</nav>' +
  '<aside id="preview-panel" class="preview-panel">' +
  '<div class="preview-head">' +
  '<div id="preview-title" style="font-weight:700;font-size:14px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Предпросмотр</div>' +
  '<button class="btn-ghost" data-action="fullscreen-preview" style="padding:5px 9px" title="На весь экран"><span class="material-symbols-outlined">fullscreen</span></button>' +
  '<button class="btn-ghost" data-action="download-preview" style="padding:5px 9px" title="Скачать"><span class="material-symbols-outlined">download</span></button>' +
  '<button class="btn-ghost" data-action="share-preview" style="padding:5px 9px" title="Публичная ссылка"><span class="material-symbols-outlined">link</span></button>' +
  '<button class="btn-ghost" data-action="close-preview" style="padding:5px 9px" title="Закрыть"><span class="material-symbols-outlined">close</span></button>' +
  '</div>' +
  '<div id="preview-body" class="preview-body"></div>' +
  '<div id="preview-info"></div>' +
  '</aside>' +

  /* ── CONTEXT MENU ── */
  '<div id="media-viewer" class="media-viewer">' +
  '<div class="mv-top"><div id="mv-title" class="mv-title">Media</div><button class="mv-icon" data-action="mv-download" title="Скачать"><span class="material-symbols-outlined">download</span></button><button class="mv-icon" data-action="mv-share" title="Публичная ссылка"><span class="material-symbols-outlined">link</span></button><button class="mv-icon" data-action="mv-close" title="Закрыть"><span class="material-symbols-outlined">close</span></button></div>' +
  '<div id="mv-stage" class="mv-stage"></div>' +
  '<div id="mv-bottom" class="mv-bottom"></div>' +
  '</div>' +
  '<div id="ctx-menu"></div>' +
  '<div id="toast" style="display:none;align-items:center;gap:10px">' +
  '  <div style="flex:1;min-width:0">' +
  '    <div id="toast-title" style="font-weight:700;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>' +
  '    <div id="toast-body" style="font-size:11.5px;color:#cbc3d7;word-break:break-all;max-height:2.8em;overflow:hidden;line-height:1.4;margin-top:2px"></div>' +
  '  </div>' +
  '  <div style="display:flex;gap:5px;flex-shrink:0">' +
  '    <button class="btn-ghost" data-action="open-toast-qr" style="padding:3px 8px;font-size:11px">QR</button>' +
  '    <button class="btn-ghost" data-action="copy-toast" style="padding:3px 8px;font-size:11px">📋</button>' +
  '    <button class="btn-ghost" data-action="hide-toast" style="padding:3px 8px;font-size:11px">✕</button>' +
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
  '<div id="upload-status" style="font-size:13px;font-weight:700;color:#d2bbff;min-width:36px">0%</div>' +
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
  '<div class="modal" style="width:460px">' +
  '<div style="font-weight:700;font-size:18px;margin-bottom:6px">Загрузить по URL</div>' +
  '<div style="font-size:12px;color:#958ea0;margin-bottom:14px">Файл попадёт в текущую папку CloudSpace</div>' +
  '<input id="url-dl-inp" class="inp" placeholder="https://example.com/file.zip" style="margin-bottom:10px">' +
  '<select id="url-mode-inp" class="inp" style="margin-bottom:10px"><option value="file">Обычный файл</option><option value="video">Медиа: видео</option><option value="audio">Медиа: MP3 audio</option><option value="best">Медиа: лучший доступный файл</option></select>' +
  '<input id="url-name-inp" class="inp" placeholder="Имя без расширения, если нужно" style="margin-bottom:6px">' +
  '<div id="url-name-hint" style="font-size:11px;color:#958ea0;margin-bottom:12px">Для медиа расширение добавится автоматически: .mp4 или .mp3</div>' +
  '<div id="url-status" style="font-size:12px;color:#958ea0;min-height:16px;margin-bottom:12px"></div>' +
  '<div style="display:flex;gap:10px;justify-content:flex-end">' +
  '<button class="btn-ghost" data-action="close-url-modal">Отмена</button>' +
  '<button class="btn-primary" data-action="confirm-url-download">Загрузить</button>' +
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
  '<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#958ea0;margin-bottom:12px;cursor:pointer"><input type="checkbox" id="sm-new-preview" checked> Страница предпросмотра</label>' +
  '<div style="display:flex;justify-content:flex-end"><button class="btn-primary" data-action="sm-create"><span class="material-symbols-outlined">add_link</span> Создать ссылку</button></div>' +
  '</div>' +
  '</div></div>' +

  '<script>' +
  'var currentPath="__dashboard__",currentView=localStorage.getItem("fm-view")||"list";' +
  'if(currentView!=="grid")currentView="list";' +
  'function encPath(p){return (p||"").split("/").filter(Boolean).map(encodeURIComponent).join("/");}' +
  'function decPath(p){return (p||"").split("/").filter(Boolean).map(function(x){try{return decodeURIComponent(x);}catch(e){return x;}}).join("/");}' +
  'function hashForPath(p){if(p==="__dashboard__")return "dashboard";if(p==="__recent__")return "recent";if(p==="__url_history__")return "url-history";if(p==="__settings__")return "settings";return p?"files/"+encPath(p):"files";}' +
  'function parseHash(){var h=(window.location.hash||"").replace(/^#/,"");if(!h)return null;if(h==="dashboard"||h==="__dashboard__")return {type:"dashboard"};if(h==="recent"||h==="__recent__")return {type:"recent"};if(h==="url-history"||h==="__url_history__")return {type:"url-history"};if(h==="settings"||h==="__settings__")return {type:"settings"};if(h==="files")return {type:"files",path:""};if(h.indexOf("files/")===0)return {type:"files",path:decPath(h.slice(6))};return {type:"files",path:decPath(h)};}' +
  'function savePath(p){try{localStorage.setItem("fm-path",p);if(!window._ignoreHash){var next="#"+hashForPath(p);if(window.location.hash!==next)window.location.hash=next;}}catch(e){}}' +
  'function handleHash(){' +
  '  var h=parseHash();if(!h)h={type:"dashboard"};' +
  '  var target=h.type==="dashboard"?"__dashboard__":h.type==="recent"?"__recent__":h.type==="url-history"?"__url_history__":h.type==="settings"?"__settings__":(h.path||"");' +
  '  if(target===currentPath)return;' +
  '  window._ignoreHash=true;' +
  '  if(h.type==="dashboard")loadDashboard();' +
  '  else if(h.type==="recent")loadRecent();' +
  '  else if(h.type==="url-history")loadUrlHistory();' +
  '  else if(h.type==="settings")loadCloudSettings();' +
  '  else navigateTo(h.path||"");' +
  '  window._ignoreHash=false;' +
  '}' +
  'window.addEventListener("hashchange",handleHash);' +
  'var renameFp="",renameIsDir=false,renameExt="";' +
  'var ctxFp="",ctxName="",ctxIsDir=false;' +
  'var dragFp=null,dragName=null,dragIsDir=false,dragEl=null;' +
  'var selectedItems={},lastEntries=[],lastBase="";' +
  'var previewFp="",previewName="",previewKind="",previewSrc="",mvZoom=1;' +
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
  'function fmtSize(b){if(!b)return "0 B";var u=["B","KB","MB","GB"],i=0;while(b>=1024&&i<3){b/=1024;i++;}return b.toFixed(i?1:0)+" "+u[i];}' +
  'function fmtSpeed(b){return fmtSize(b||0)+"/s";}' +
  'function fmtDate(ts){if(!ts)return "";return new Date(ts).toLocaleDateString("ru-RU",{day:"2-digit",month:"short",year:"numeric"});}' +
  'function fmtDateTime(ts){if(!ts)return "";return new Date(ts).toLocaleString("ru-RU",{day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"});}' +
  'function activePath(){return (currentPath==="__dashboard__"||currentPath==="__recent__"||currentPath==="__url_history__"||currentPath==="__settings__")?"":currentPath;}' +
  'function setNavActive(action){document.querySelectorAll(".nav-item,.bottom-nav-item").forEach(function(x){x.classList.toggle("active",x.dataset.action===action);});}' +
  'function parentPath(p){var parts=(p||"").split("/").filter(Boolean);parts.pop();return parts.join("/");}' +
  'function splitExt(name,isDir){if(isDir)return {base:name,ext:""};var dot=name.lastIndexOf(".");if(dot<=0)return {base:name,ext:""};return {base:name.slice(0,dot),ext:name.slice(dot)};}' +
  'function setView(v){currentView=v==="grid"?"grid":"list";localStorage.setItem("fm-view",currentView);if(currentPath!=="__recent__"&&currentPath!=="__url_history__")loadDir();}' +
  'function selectedList(){return Object.keys(selectedItems).map(function(k){return selectedItems[k];});}' +
  'function updateSelectionBar(){var n=selectedList().length;document.getElementById("selection-count").textContent="Выбрано: "+n;document.getElementById("selection-bar").style.display=n?"flex":"none";}' +
  'function clearSelection(refresh){selectedItems={};updateSelectionBar();if(refresh)renderContent(lastEntries,lastBase);}' +
  'function toggleSelect(fp,name,isDir,checked){if(checked)selectedItems[fp]={fp:fp,name:name,isDir:isDir};else delete selectedItems[fp];updateSelectionBar();renderContent(lastEntries,lastBase);}' +
  'function selectAllVisible(checked){selectedItems={};if(checked){for(var i=0;i<lastEntries.length;i++){var f=lastEntries[i];var fp=lastBase?(lastBase+"/"+f.name):f.name;selectedItems[fp]={fp:fp,name:f.name,isDir:!!f.isDir};}}updateSelectionBar();renderContent(lastEntries,lastBase);}' +
  'function refreshCurrent(){if(currentPath==="__dashboard__")loadDashboard();else if(currentPath==="__recent__")loadRecent();else if(currentPath==="__url_history__")loadUrlHistory();else if(currentPath==="__settings__")loadCloudSettings();else loadDir();}' +
  'function goBackPath(){var p=activePath();if(!p)return;navigateTo(parentPath(p));}' +
  'function allVisibleSelected(files,base){if(!files.length)return false;for(var i=0;i<files.length;i++){var fp=base?(base+"/"+files[i].name):files[i].name;if(!selectedItems[fp])return false;}return true;}' +
  'function selectedPayload(){return selectedList().map(function(x){return {path:x.fp,isDir:x.isDir};});}' +
  'function itemParent(fp){var parts=(fp||"").split("/").filter(Boolean);parts.pop();return parts.join("/");}' +
  'function setSectionChrome(kind){var a=document.querySelector(".mobile-actions");if(a)a.style.display=kind==="files"?"flex":"none";if(kind!=="files"){try{clearTimeout(searchTimer);var s=document.getElementById("search-inp");if(s)s.value="";}catch(e){}}}' +
  'function moveItemTo(from,name,dest){dest=dest||"";if(!from||dest===from||dest.indexOf(from+"/")===0)return;var to=dest?(dest+"/"+name):name;if(to===from)return;fetch("/api/fm/move",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({from:from,to:to})}).then(function(r){return r.json();}).then(function(d){if(d.ok)navigateTo(activePath());else alert(d.error||"Ошибка перемещения");});}' +
  'function showToast(title,body,url){title=title||"";body=body||"";toastUrl=url||"";if(!title&&!body&&!url)return hideToast();document.getElementById("toast-title").textContent=title;document.getElementById("toast-body").textContent=body||url||"";document.getElementById("toast").style.display="flex";if(url&&navigator.clipboard)navigator.clipboard.writeText(url).catch(function(){});}' +
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
  'function applyTheme(){var light=localStorage.getItem("fm-theme")==="light";document.body.classList.toggle("light",light);}' +
  'function toggleTheme(){localStorage.setItem("fm-theme",document.body.classList.contains("light")?"dark":"light");applyTheme();}' +
  'function fileKind(name){var ext=(name.split(".").pop()||"").toLowerCase();if(["png","jpg","jpeg","gif","webp","svg","bmp"].includes(ext))return"image";if(["mp4","webm","ogg","mov","mkv"].includes(ext))return"video";if(["mp3","wav","m4a","flac","aac","oga"].includes(ext))return"audio";if(ext==="pdf")return"pdf";if(["docx","xlsx","xls","ods","csv"].includes(ext))return"office";if(["zip","rar","7z","tar","gz"].includes(ext))return"archive";if(["exe","msi","apk","deb"].includes(ext))return"app";if(["txt","log","md","json","js","css","html","xml","yml","yaml","ini","conf"].includes(ext))return"text";return"file";}' +
  'function fileThumb(name,fp,isDir){if(isDir)return \'<div class="file-thumb"><span class="material-symbols-outlined">folder</span></div>\';var k=fileKind(name);var ext=(name.split(".").pop()||"").toLowerCase();if(k==="image"||ext==="exe"||k==="video"){var fb=ext==="exe"?"deployed_code":k==="video"?"movie":"image";return \'<div class="file-thumb"><img src="/api/fm/preview?path=\'+encodeURIComponent(fp)+\'&thumb=1" onerror="this.outerHTML=\'+String.fromCharCode(39)+\'<span class=material-symbols-outlined>\'+fb+\'</span>\'+String.fromCharCode(39)+\'"></div>\';}var icons={video:"movie",audio:"audio_file",pdf:"picture_as_pdf",office:"table_view",archive:"folder_zip",app:"deployed_code",text:"article",file:"draft"};return \'<div class="file-thumb"><span class="material-symbols-outlined">\'+(icons[k]||"draft")+\'</span></div>\';}' +
  'function makeZip(items,name,startDownload){return fetch("/api/fm/zip",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({items:items,name:name||"cloudspace.zip"})}).then(function(r){return r.json();}).then(function(d){if(!d.ok)throw new Error(d.error||"Ошибка архива");if(startDownload)window.location.href=d.url;return d;});}' +
  'function downloadSelected(){var items=selectedList();if(!items.length)return;if(items.some(function(x){return x.isDir;})||items.length>5){zipSelected();return;}items.forEach(function(it,i){setTimeout(function(){var a=document.createElement("a");a.href="/api/fm/download?path="+encodeURIComponent(it.fp);a.download=it.name;document.body.appendChild(a);a.click();a.remove();},i*350);});}' +
  'function zipSelected(){var items=selectedPayload();if(!items.length)return;makeZip(items,"cloudspace.zip",true).catch(function(e){alert(e.message);});}' +
  'function openShareModal(payload,label){pendingShare=payload;document.getElementById("share-target-label").textContent=label||"Настройки доступа";document.getElementById("share-expire-inp").value="0";document.getElementById("share-max-inp").value="";document.getElementById("share-preview-chk").checked=true;document.getElementById("share-status").textContent="";document.getElementById("modal-share").style.display="flex";}' +
  'function closeShareModal(){document.getElementById("modal-share").style.display="none";pendingShare=null;}' +
  'function confirmShare(){if(!pendingShare)return;var body=Object.assign({},pendingShare);body.expiresIn=parseInt(document.getElementById("share-expire-inp").value||"0",10);body.maxDownloads=parseInt(document.getElementById("share-max-inp").value||"0",10);body.preview=document.getElementById("share-preview-chk").checked;var st=document.getElementById("share-status");st.textContent="Создаю ссылку...";fetch("/api/fm/share",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json();}).then(function(d){if(d.ok){closeShareModal();copyOrShowLink(d.url);if(previewFp)renderPreviewInfo(previewFp,previewName);}else st.textContent=d.error||"Ошибка ссылки";}).catch(function(){st.textContent="Ошибка ссылки";});}' +
  'function shareSelected(){var items=selectedPayload();if(!items.length)return;openShareModal({items:items},"Выбрано объектов: "+items.length);}' +
  'function shareOne(fp){openShareModal({path:fp},"Объект: "+fp);}' +
  'function shareExpireOptions(selected){var opts=[[0,"Без ограничения"],[1,"1 час"],[24,"1 день"],[72,"3 дня"],[168,"7 дней"],[720,"30 дней"]];return opts.map(function(o){return "<option value=\\""+o[0]+"\\""+(String(selected)===String(o[0])?" selected":"")+">"+o[1]+"</option>";}).join("");}' +
  'function shareDateText(v){return v?fmtDateTime(v):"Без ограничения";}' +
  'function shareMaxText(v){return v?String(v):"Без лимита";}' +
  'function openShareManager(fp,name){shareManagerFp=fp;shareManagerName=name||fp;document.getElementById("sm-file-label").textContent=shareManagerName+" · "+shareManagerFp;document.getElementById("sm-status").textContent="";document.getElementById("modal-share-manager").style.display="flex";loadShareManager();}' +
  'function closeShareManager(){document.getElementById("modal-share-manager").style.display="none";shareManagerFp="";shareManagerName="";}' +
  'function renderShareManager(items){var box=document.getElementById("sm-list");if(!items.length){box.innerHTML=\'<div class="card" style="padding:14px;margin:0;color:#958ea0">У этого файла пока нет публичных ссылок.</div>\';return;}var h="";items.forEach(function(x){var full=window.location.origin+x.url;h+=\'<div class="card" style="padding:14px;margin:0 0 10px 0"><div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:10px"><div style="flex:1;min-width:0"><div style="font-size:12px;color:#958ea0;margin-bottom:4px">Создана: \'+H(fmtDateTime(x.created))+\'; действует до: \'+H(shareDateText(x.expiresAt))+\'</div><div style="font-size:12px;color:#d2bbff;word-break:break-all">\'+H(full)+\'</div><div style="font-size:12px;color:#958ea0;margin-top:4px">Скачиваний: \'+H(String(x.downloads||0))+\' / \'+H(shareMaxText(x.maxDownloads))+\'</div></div><button class="btn-ghost" data-action="sm-qr" data-url="\'+H(full)+\'" style="padding:6px 9px"><span class="material-symbols-outlined">qr_code_2</span></button><button class="btn-ghost" data-action="sm-copy" data-url="\'+H(full)+\'" style="padding:6px 9px"><span class="material-symbols-outlined">content_copy</span></button></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px"><select id="sm-expire-\'+H(x.token)+\'" class="inp">\'+shareExpireOptions(0)+\'</select><input id="sm-max-\'+H(x.token)+\'" class="inp" type="number" min="0" step="1" value="\'+H(x.maxDownloads||"")+\'" placeholder="0 = без лимита"></div><label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#958ea0;margin-bottom:10px"><input type="checkbox" id="sm-preview-\'+H(x.token)+\'" \'+(x.preview!==false?"checked":"")+\' > Страница предпросмотра</label><div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn-ghost" data-action="sm-save" data-token="\'+H(x.token)+\'">Сохранить</button><button class="btn-ghost" data-action="sm-revoke" data-token="\'+H(x.token)+\'" style="color:#ffb4ab;border-color:#93000a">Отозвать</button></div></div>\';});box.innerHTML=h;}' +
  'function loadShareManager(){if(!shareManagerFp)return;document.getElementById("sm-status").textContent="Загружаю ссылки...";fetch("/api/fm/shares?path="+encodeURIComponent(shareManagerFp)).then(function(r){return r.json();}).then(function(d){if(!d.ok){document.getElementById("sm-status").textContent=d.error||"Ошибка";return;}document.getElementById("sm-status").textContent="";renderShareManager(d.shares||[]);}).catch(function(){document.getElementById("sm-status").textContent="Ошибка загрузки ссылок";});}' +
  'function createManagedShare(){if(!shareManagerFp)return;var body={path:shareManagerFp,expiresIn:parseInt(document.getElementById("sm-new-expire").value||"0",10),maxDownloads:parseInt(document.getElementById("sm-new-max").value||"0",10),preview:document.getElementById("sm-new-preview").checked};document.getElementById("sm-status").textContent="Создаю ссылку...";fetch("/api/fm/share",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json();}).then(function(d){if(d.ok){document.getElementById("sm-new-expire").value="0";document.getElementById("sm-new-max").value="";document.getElementById("sm-new-preview").checked=true;copyOrShowLink(d.url);loadShareManager();if(previewFp===shareManagerFp)renderPreviewInfo(previewFp,previewName);}else document.getElementById("sm-status").textContent=d.error||"Ошибка ссылки";}).catch(function(){document.getElementById("sm-status").textContent="Ошибка ссылки";});}' +
  'function saveManagedShare(token){var body={expiresIn:parseInt((document.getElementById("sm-expire-"+token)||{}).value||"0",10),maxDownloads:parseInt((document.getElementById("sm-max-"+token)||{}).value||"0",10),preview:!!(document.getElementById("sm-preview-"+token)||{}).checked};document.getElementById("sm-status").textContent="Сохраняю...";fetch("/api/fm/share/"+encodeURIComponent(token),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json();}).then(function(d){document.getElementById("sm-status").textContent=d.ok?"Сохранено":(d.error||"Ошибка");loadShareManager();if(previewFp===shareManagerFp)renderPreviewInfo(previewFp,previewName);}).catch(function(){document.getElementById("sm-status").textContent="Ошибка сохранения";});}' +
  'function revokeManagedShare(token){if(!confirm("Отозвать эту публичную ссылку?"))return;fetch("/api/share/"+encodeURIComponent(token),{method:"DELETE"}).then(function(r){return r.json();}).then(function(d){if(!d.ok)throw new Error(d.error||"Ошибка");loadShareManager();if(previewFp===shareManagerFp)renderPreviewInfo(previewFp,previewName);}).catch(function(e){document.getElementById("sm-status").textContent=e.message;});}' +
  'function copyPlain(url){if(navigator.clipboard)navigator.clipboard.writeText(url).then(function(){showToast("Скопировано",url,url);});}' +

  /* ── BREADCRUMB ── */
  'function renderBreadcrumb(p){' +
  '  var el=document.getElementById("breadcrumb");' +
  '  var parts=p?p.split("/").filter(Boolean):[];' +
  '  var back=document.getElementById("go-back-btn");if(back)back.dataset.dropPath=parentPath(p);' +
  '  var html=\'<span data-action="navigate" data-drop-path="" data-fp="" style="color:#a078ff;cursor:pointer;font-weight:600">Мои файлы</span>\';' +
  '  var built="";' +
  '  for(var i=0;i<parts.length;i++){' +
  '    built=built?(built+"/"+parts[i]):parts[i];' +
  '    html+=\'<span class="breadcrumb-sep">/</span>\';' +
  '    html+=\'<span data-action="navigate" data-drop-path="\'+H(built)+\'" data-fp="\'+H(built)+\'" style="cursor:pointer;color:#cbc3d7">\'+H(parts[i])+"</span>";' +
  '  }' +
  '  el.innerHTML=html;' +
  '}' +

  /* ── NAVIGATE & LOAD ── */
  'function navigateTo(p){p=p||"";if(p!==currentPath)clearSelection(false);currentPath=p;savePath(p);loadDir();}' +
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
  "  var bc=document.getElementById(\"breadcrumb\");if(bc)bc.innerHTML='<span style=\"color:#a078ff;font-weight:800\">CloudSpace</span><span class=\"breadcrumb-sep\">/</span><span>Главная</span>';" +
  "  var h='';" +
  "  h+='<section style=\"display:grid;grid-template-columns:minmax(0,1.55fr) minmax(300px,.85fr);gap:18px;align-items:stretch\">';" +
  "  h+='<div style=\"position:relative;overflow:hidden;border:1px solid rgba(160,120,255,.36);border-radius:24px;padding:28px;background:radial-gradient(circle at 12% 0%,rgba(160,120,255,.34),transparent 34%),linear-gradient(135deg,#211934 0%,#141416 58%,#101114 100%);min-height:290px;box-shadow:0 24px 80px rgba(0,0,0,.32)\">';" +
  "  h+='<div style=\"display:flex;align-items:center;gap:10px;margin-bottom:20px;color:#d7c7ff;font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:.08em\"><span class=\"material-symbols-outlined\">bolt</span> Быстрая отправка на VPS</div>';" +
  "  h+='<h1 style=\"font-size:34px;line-height:1.08;margin:0 0 10px;color:#fff;font-weight:900;max-width:760px\">Скачай файл на сервер и забери с любого устройства</h1>';" +
  "  h+='<div style=\"color:#bfb5d6;font-size:14px;line-height:1.55;max-width:780px;margin-bottom:22px\">Вставь ссылку, выбери режим или закинь файл с компьютера. Всё попадёт в CloudSpace, без прыжков между вкладками.</div>';" +
  "  h+='<div style=\"display:grid;grid-template-columns:minmax(0,1fr) 170px;gap:10px;margin-bottom:10px\"><input id=\"dash-url-inp\" class=\"inp\" placeholder=\"https://example.com/file.zip или ссылка на видео\"><select id=\"dash-mode-inp\" class=\"inp\"><option value=\"file\">Обычный файл</option><option value=\"video\">Видео</option><option value=\"audio\">MP3 audio</option><option value=\"best\">Лучший файл</option></select></div>';" +
  "  h+='<div style=\"display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:10px;align-items:center\"><input id=\"dash-name-inp\" class=\"inp\" placeholder=\"Имя без расширения, если нужно\"><button class=\"btn-primary\" data-action=\"dashboard-url-download\"><span class=\"material-symbols-outlined\">download</span> Загрузить</button><button class=\"btn-ghost\" data-action=\"upload-btn\"><span class=\"material-symbols-outlined\">upload_file</span> С ПК</button></div>';" +
  "  h+='<div id=\"dash-url-status\" style=\"font-size:12px;color:#8ff0a4;min-height:18px;margin-top:12px\"></div>';" +
  "  h+='</div>';" +
  "  h+='<div style=\"display:grid;grid-template-rows:auto 1fr;gap:18px\">';" +
  "  h+='<div class=\"card\" data-action=\"nav-files\" style=\"margin:0;padding:22px;cursor:pointer;border-radius:24px;background:linear-gradient(180deg,#1d1d21,#17171a);min-height:150px\"><div style=\"display:flex;align-items:center;justify-content:space-between;gap:12px\"><span class=\"material-symbols-outlined\" style=\"font-size:36px;color:#9ddcff\">folder_open</span><span class=\"material-symbols-outlined\" style=\"color:#958ea0\">arrow_forward</span></div><div style=\"font-size:22px;font-weight:900;color:#fff;margin-top:22px\">Мои файлы</div><div id=\"dash-files-meta\" style=\"font-size:13px;color:#a9a1b8;margin-top:6px\">Считаю хранилище...</div></div>';" +
  "  h+='<div class=\"card\" style=\"margin:0;padding:22px;border-radius:24px;background:linear-gradient(180deg,#191d1a,#151716)\"><div style=\"font-size:12px;color:#8ff0a4;font-weight:900;text-transform:uppercase;letter-spacing:.08em;margin-bottom:14px\">Диск</div><div style=\"display:flex;align-items:flex-end;justify-content:space-between;gap:12px\"><div id=\"dash-disk-big\" style=\"font-size:30px;font-weight:900;color:#fff\">...</div><div id=\"dash-disk-small\" style=\"font-size:12px;color:#a9a1b8;text-align:right\">Загрузка</div></div><div class=\"disk-bar\" style=\"margin-top:18px;height:8px\"><div class=\"disk-fill\" id=\"dash-disk-fill\" style=\"width:0%\"></div></div></div>';" +
  "  h+='</div>';" +
  "  h+='</section>';" +
  "  h+='<section style=\"display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-top:18px\">';" +
  "  h+=dashActionCard(\"schedule\",\"Недавние\",\"Последние файлы и быстрый возврат\",\"nav-recent\",\"#d2bbff\");" +
  "  h+=dashActionCard(\"history\",\"История URL\",\"Повторы и медиа-задачи\",\"nav-url-history\",\"#ffd166\");" +
  "  h+=dashActionCard(\"settings\",\"Настройки\",\"Пароль, токен, аккаунты\",\"nav-settings\",\"#8ff0a4\");" +
  "  h+=dashActionCard(\"create_new_folder\",\"Новая папка\",\"Сразу перейти в файлы\",\"nav-files\",\"#9ddcff\");" +
  "  h+='</section>';" +
  "  h+='<section style=\"display:grid;grid-template-columns:minmax(0,1fr) minmax(320px,.75fr);gap:18px;margin-top:18px\">';" +
  "  h+='<div class=\"card\" style=\"margin:0;padding:22px;border-radius:24px\"><div style=\"display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px\"><div><div style=\"font-size:18px;font-weight:900;color:#fff\">Недавние файлы</div><div style=\"font-size:12px;color:#958ea0;margin-top:2px\">То, что пригодится открыть следующим</div></div><button class=\"btn-ghost\" data-action=\"nav-recent\">Все</button></div><div id=\"dash-recent-list\" style=\"display:flex;flex-direction:column;gap:8px\"><div style=\"color:#494454;font-size:13px\">Загрузка...</div></div></div>';" +
  "  h+='<div class=\"card\" style=\"margin:0;padding:22px;border-radius:24px\"><div style=\"font-size:18px;font-weight:900;color:#fff;margin-bottom:14px\">Сейчас</div><div style=\"display:grid;gap:10px\"><div style=\"display:flex;justify-content:space-between;gap:12px;color:#cbc3d7\"><span>Активные загрузки</span><b id=\"dash-active-count\">0</b></div><div style=\"display:flex;justify-content:space-between;gap:12px;color:#cbc3d7\"><span>История URL</span><b id=\"dash-history-count\">...</b></div><div style=\"display:flex;justify-content:space-between;gap:12px;color:#cbc3d7\"><span>Текущий режим</span><b>Cloud</b></div></div></div>';" +
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
  "  fetch(\"/api/fm/media-jobs?scope=history\").then(function(r){return r.json();}).then(function(items){var el=document.getElementById(\"dash-history-count\");if(el)el.textContent=Array.isArray(items)?items.length:0;}).catch(function(){});" +
  "}" +
  "function dashActionCard(icon,title,body,action,color){return '<button class=\"card\" data-action=\"'+action+'\" style=\"margin:0;padding:18px;border-radius:20px;text-align:left;cursor:pointer;background:#18181b;color:#e4e1e6;min-height:132px\"><span class=\"material-symbols-outlined\" style=\"font-size:30px;color:'+color+'\">'+icon+'</span><div style=\"font-size:16px;font-weight:900;margin-top:18px\">'+title+'</div><div style=\"font-size:12px;color:#958ea0;margin-top:5px;line-height:1.4\">'+body+'</div></button>';}" +
  'function addDashboardUrlDownload(){var url=document.getElementById("dash-url-inp").value.trim(),name=document.getElementById("dash-name-inp").value.trim(),mode=document.getElementById("dash-mode-inp").value,st=document.getElementById("dash-url-status");if(!url){st.textContent="Вставь URL";return;}var media=mode!=="file";if(media)name=stripInputMediaExt(name);st.textContent=media?"Запускаю медиа-загрузку...":"Добавляю загрузку...";fetch(media?"/api/fm/media":"/api/fm/add-url",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url:url,filename:name,path:"",mode:mode})}).then(function(r){return r.json();}).then(function(d){if(d.ok){var gid=d.gid||(d.job&&d.job.id);if(gid){knownMediaStatuses[gid]="active";markPendingUrlJob(gid,"");}document.getElementById("dash-url-inp").value="";document.getElementById("dash-name-inp").value="";st.textContent="Загрузка запущена";loadTransfers();}else st.textContent=d.error||"Ошибка";}).catch(function(){st.textContent="Ошибка";});}' +
  'function settingsCard(title,body){return \'<div class="card" style="margin:0;padding:18px">\'+\'<div style="font-size:15px;font-weight:800;margin-bottom:12px;color:#e4e1e6">\'+title+\'</div>\'+body+"</div>";}' +
  'function setCloudStatus(id,msg,ok){var el=document.getElementById(id);if(!el)return;el.textContent=msg||"";el.style.color=ok?"#8ff0a4":"#ffb4ab";}' +
  'function fmtMbps(bytes,ms){if(!ms)return "\\u2014";return ((bytes*8)/(ms/1000)/1000000).toFixed(2)+" Mbps";}' +
  'function setSpeedStatus(msg,ok){var el=document.getElementById("speed-status");if(!el)return;el.textContent=msg||"";el.style.color=ok?"#8ff0a4":"#958ea0";}' +
  'async function runSpeedTest(){var st=document.getElementById("speed-status"),p=document.getElementById("speed-ping"),d=document.getElementById("speed-down"),u=document.getElementById("speed-up");if(!st||!p||!d||!u)return;p.textContent=d.textContent=u.textContent="...";setSpeedStatus("\\u041f\\u0440\\u043e\\u0432\\u0435\\u0440\\u044f\\u044e \\u0437\\u0430\\u0434\\u0435\\u0440\\u0436\\u043a\\u0443...",false);try{var pingTimes=[];for(var i=0;i<4;i++){var t0=performance.now();await fetch("/api/speedtest/ping?x="+Date.now()+"-"+i,{cache:"no-store"});pingTimes.push(performance.now()-t0);}var ping=Math.round(pingTimes.reduce(function(a,b){return a+b;},0)/pingTimes.length);p.textContent=ping+" ms";setSpeedStatus("\\u041f\\u0440\\u043e\\u0432\\u0435\\u0440\\u044f\\u044e \\u0441\\u043a\\u0430\\u0447\\u0438\\u0432\\u0430\\u043d\\u0438\\u0435...",false);var size=10*1024*1024,t1=performance.now();var r=await fetch("/api/speedtest/download?size="+size+"&x="+Date.now(),{cache:"no-store"});var buf=await r.arrayBuffer();var downMs=performance.now()-t1;d.textContent=fmtMbps(buf.byteLength,downMs);setSpeedStatus("\\u041f\\u0440\\u043e\\u0432\\u0435\\u0440\\u044f\\u044e \\u0432\\u044b\\u0433\\u0440\\u0443\\u0437\\u043a\\u0443...",false);var upSize=4*1024*1024,payload=new Uint8Array(upSize);for(var j=0;j<upSize;j+=4096)payload[j]=j%251;var t2=performance.now();await fetch("/api/speedtest/upload?x="+Date.now(),{method:"POST",headers:{"Content-Type":"application/octet-stream"},body:payload,cache:"no-store"});var upMs=performance.now()-t2;u.textContent=fmtMbps(upSize,upMs);setSpeedStatus("\\u0413\\u043e\\u0442\\u043e\\u0432\\u043e",true);}catch(e){setSpeedStatus("\\u041d\\u0435 \\u0443\\u0434\\u0430\\u043b\\u043e\\u0441\\u044c \\u0432\\u044b\\u043f\\u043e\\u043b\\u043d\\u0438\\u0442\\u044c \\u0442\\u0435\\u0441\\u0442",false);if(p.textContent==="...")p.textContent="\\u2014";if(d.textContent==="...")d.textContent="\\u2014";if(u.textContent==="...")u.textContent="\\u2014";}}' +
  'function loadCloudSettings(){currentPath="__settings__";savePath("__settings__");clearSelection(false);setSectionChrome("settings");setNavActive("nav-settings");var bc=document.getElementById("breadcrumb");if(bc)bc.innerHTML=\'<span style="color:#a078ff;font-weight:700">Настройки</span>\';var html=\'<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px">\';html+=settingsCard("\u041f\u0440\u043e\u0444\u0438\u043b\u044c",\'<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px"><div id="settings-profile-avatar" style="width:48px;height:48px;border-radius:16px;background:linear-gradient(135deg,#a078ff,#6d3bd7);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:900;font-size:18px;flex:0 0 auto">?</div><div style="min-width:0;flex:1"><div id="settings-profile-login" style="font-size:12px;color:#958ea0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">@...</div><div id="settings-profile-role" style="font-size:12px;color:#d2bbff;margin-top:2px"></div></div></div><div style="font-size:12px;color:#958ea0;margin-bottom:8px">\u0418\u043c\u044f \u0432 \u043f\u0440\u043e\u0444\u0438\u043b\u0435</div><input id="cloud-profile-label" class="inp" maxlength="40" placeholder="CloudSpace" style="margin-bottom:10px"><button class="btn-primary" data-action="settings-save-profile">\u0421\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c</button><div id="cloud-profile-status" style="font-size:12px;margin-top:8px;min-height:16px"></div>\');html+=settingsCard("Хранение файлов",\'<div style="font-size:12px;color:#958ea0;margin-bottom:10px">Автоудаление старых файлов</div><select id="cloud-retention" class="inp" style="margin-bottom:10px"><option value="1">1 день</option><option value="3">3 дня</option><option value="7">7 дней</option><option value="30">30 дней</option><option value="0">Никогда</option></select><button class="btn-primary" data-action="settings-save-retention">Сохранить</button><div id="cloud-retention-status" style="font-size:12px;margin-top:8px;min-height:16px"></div>\');html+=settingsCard("Уведомления",\'<div id="cloud-notif-status" style="font-size:12px;color:#958ea0;margin-bottom:10px">Проверяю...</div><button class="btn-ghost" data-action="settings-notif"><span class="material-symbols-outlined">notifications</span> Разрешить уведомления</button>\');html+=settingsCard("Speed test",\'<div style="font-size:12px;color:#958ea0;margin-bottom:10px">\u041f\u0440\u043e\u0432\u0435\u0440\u043a\u0430 \u0441\u043a\u043e\u0440\u043e\u0441\u0442\u0438 \u043c\u0435\u0436\u0434\u0443 \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u043e\u043c \u0438 VPS</div><button class="btn-primary" data-action="settings-speedtest"><span class="material-symbols-outlined">speed</span> \u0417\u0430\u043f\u0443\u0441\u0442\u0438\u0442\u044c \u0442\u0435\u0441\u0442</button><div id="speed-status" style="font-size:12px;color:#958ea0;margin-top:10px;min-height:16px"></div><div id="speed-result" class="speed-result"><div class="speed-metric"><b id="speed-ping">\u2014</b><span>Ping</span></div><div class="speed-metric"><b id="speed-down">\u2014</b><span>Download</span></div><div class="speed-metric"><b id="speed-up">\u2014</b><span>Upload</span></div></div>\');html+=settingsCard("Токен расширения",\'<div id="cloud-token-display" style="font-size:12px;color:#d2bbff;word-break:break-all;margin-bottom:10px">Скрыт</div><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn-ghost" data-action="settings-load-token">Показать</button><button class="btn-ghost" data-action="settings-copy-token">Копировать</button><button class="btn-ghost" data-action="settings-reset-token" style="color:#ffb4ab;border-color:#93000a">Сбросить</button></div><div id="cloud-token-status" style="font-size:12px;margin-top:8px;min-height:16px"></div>\');html+=settingsCard("Пароль",\'<input id="cloud-pass-current" class="inp" type="password" placeholder="Текущий пароль" style="margin-bottom:10px"><input id="cloud-pass-new" class="inp" type="password" placeholder="Новый пароль" style="margin-bottom:10px"><button class="btn-primary" data-action="settings-change-password">Сменить пароль</button><div id="cloud-pass-status" style="font-size:12px;margin-top:8px;min-height:16px"></div>\');html+=\'<div id="cloud-users-section" class="card" style="margin:0;padding:18px;display:none"><div style="font-size:15px;font-weight:800;margin-bottom:12px;color:#e4e1e6">Аккаунты</div><div id="cloud-users-list" style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px"></div><div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px"><input id="cloud-new-username" class="inp" placeholder="Логин"><input id="cloud-new-password" class="inp" placeholder="Пароль"><input id="cloud-new-label" class="inp" placeholder="Имя"></div><button class="btn-primary" data-action="settings-add-user">Добавить аккаунт</button><div id="cloud-users-status" style="font-size:12px;margin-top:8px;min-height:16px"></div></div>\';html+="</div>";document.getElementById("file-area").innerHTML=html;loadCloudProfile();loadCloudRetention();updateCloudNotifStatus();loadCloudUsers();}' +
  'function loadCloudRetention(){fetch("/api/settings").then(function(r){return r.json();}).then(function(d){var el=document.getElementById("cloud-retention");if(el)el.value=String(d.retention);}).catch(function(){});}' +
  'function saveCloudRetention(){var v=document.getElementById("cloud-retention").value;fetch("/api/settings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({retention:parseInt(v,10)})}).then(function(r){return r.json();}).then(function(d){setCloudStatus("cloud-retention-status",d.ok?"Сохранено":(d.error||"Ошибка"),!!d.ok);}).catch(function(){setCloudStatus("cloud-retention-status","Ошибка",false);});}' +
  'function updateCloudNotifStatus(){var el=document.getElementById("cloud-notif-status");if(!el)return;if(!("Notification" in window)){el.textContent="Браузерные уведомления недоступны";return;}el.textContent=Notification.permission==="granted"?"Уведомления включены":Notification.permission==="denied"?"Уведомления запрещены в браузере":"Уведомления еще не разрешены";}' +
  'function requestCloudNotif(){if(!("Notification" in window))return;Notification.requestPermission().then(updateCloudNotifStatus);}' +
  'function loadCloudToken(){fetch("/api/mytoken").then(function(r){return r.json();}).then(function(d){document.getElementById("cloud-token-display").textContent=d.token||"";setCloudStatus("cloud-token-status","Токен загружен",true);}).catch(function(){setCloudStatus("cloud-token-status","Ошибка токена",false);});}' +
  'function copyCloudToken(){var t=(document.getElementById("cloud-token-display")||{}).textContent||"";if(!t||t==="Скрыт"){loadCloudToken();return;}navigator.clipboard&&navigator.clipboard.writeText(t).then(function(){setCloudStatus("cloud-token-status","Скопировано",true);});}' +
  'function resetCloudToken(){if(!confirm("Сбросить токен расширения? Старый перестанет работать."))return;fetch("/api/mytoken/reset",{method:"POST"}).then(function(r){return r.json();}).then(function(d){document.getElementById("cloud-token-display").textContent=d.token||"";setCloudStatus("cloud-token-status","Новый токен готов",true);}).catch(function(){setCloudStatus("cloud-token-status","Ошибка сброса",false);});}' +
  'function updateSidebarProfile(d){var label=d.label||d.username||"",user=d.username||"",role=d.isAdmin?"Admin":"User";var ls=document.getElementById("profile-label-sidebar"),av=document.getElementById("profile-avatar-sidebar"),ms=document.getElementById("profile-meta-sidebar"),sl=document.getElementById("settings-profile-login"),sr=document.getElementById("settings-profile-role"),sa=document.getElementById("settings-profile-avatar");if(ls)ls.textContent=label;if(av)av.textContent=(label||user||"?").trim().charAt(0).toUpperCase()||"?";if(sa)sa.textContent=(label||user||"?").trim().charAt(0).toUpperCase()||"?";if(ms)ms.textContent="@"+user+" \u00b7 "+role;if(sl)sl.textContent="@"+user;if(sr)sr.textContent=role;}\n' +
  'function loadCloudProfile(){fetch("/api/me").then(function(r){return r.json();}).then(function(d){updateSidebarProfile(d);var inp=document.getElementById("cloud-profile-label");if(inp)inp.value=d.label||d.username||"";}).catch(function(){setCloudStatus("cloud-profile-status","\u041e\u0448\u0438\u0431\u043a\u0430 \u043f\u0440\u043e\u0444\u0438\u043b\u044f",false);});}\n' +
  'function saveCloudProfile(){var inp=document.getElementById("cloud-profile-label"),label=(inp&&inp.value||"").trim();fetch("/api/me",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({label:label})}).then(function(r){return r.json().then(function(d){d._ok=r.ok;return d;});}).then(function(d){setCloudStatus("cloud-profile-status",d._ok?"\u0421\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u043e":(d.error||"\u041e\u0448\u0438\u0431\u043a\u0430"),d._ok);if(d._ok)updateSidebarProfile(d);}).catch(function(){setCloudStatus("cloud-profile-status","\u041e\u0448\u0438\u0431\u043a\u0430",false);});}\n' +
  'function changeCloudPassword(){var currentPassword=document.getElementById("cloud-pass-current").value,newPassword=document.getElementById("cloud-pass-new").value;fetch("/api/change-password",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({currentPassword:currentPassword,newPassword:newPassword})}).then(function(r){return r.json().then(function(d){d._ok=r.ok;return d;});}).then(function(d){setCloudStatus("cloud-pass-status",d._ok?"Пароль изменён":(d.error||"Ошибка"),d._ok);if(d._ok){document.getElementById("cloud-pass-current").value="";document.getElementById("cloud-pass-new").value="";}}).catch(function(){setCloudStatus("cloud-pass-status","Ошибка",false);});}' +
  'function loadCloudUsers(){fetch("/api/users").then(function(r){if(!r.ok)throw new Error("not admin");return r.json();}).then(function(users){var sec=document.getElementById("cloud-users-section"),box=document.getElementById("cloud-users-list");if(!sec||!box)return;sec.style.display="block";box.innerHTML=users.map(function(u){return \'<div style="display:flex;align-items:center;gap:8px;border:1px solid #353437;border-radius:12px;padding:8px 10px"><div style="flex:1"><b>\'+H(u.username)+\'</b><div style="font-size:12px;color:#958ea0">\'+H(u.label||"")+\' \'+(u.isAdmin?"· admin":"")+\'</div></div><button class="btn-ghost" data-action="settings-delete-user" data-user="\'+H(u.username)+\'" style="color:#ffb4ab;border-color:#93000a">Удалить</button></div>\';}).join("");}).catch(function(){var sec=document.getElementById("cloud-users-section");if(sec)sec.style.display="none";});}' +
  'function addCloudUser(){var username=document.getElementById("cloud-new-username").value.trim(),password=document.getElementById("cloud-new-password").value,label=document.getElementById("cloud-new-label").value.trim();fetch("/api/users",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:username,password:password,label:label})}).then(function(r){return r.json().then(function(d){d._ok=r.ok;return d;});}).then(function(d){setCloudStatus("cloud-users-status",d._ok?"Аккаунт добавлен":(d.error||"Ошибка"),d._ok);if(d._ok){document.getElementById("cloud-new-username").value="";document.getElementById("cloud-new-password").value="";document.getElementById("cloud-new-label").value="";loadCloudUsers();}}).catch(function(){setCloudStatus("cloud-users-status","Ошибка",false);});}' +
  'function deleteCloudUser(username){if(!confirm("Удалить аккаунт "+username+"?"))return;fetch("/api/users/"+encodeURIComponent(username),{method:"DELETE"}).then(function(r){return r.json().then(function(d){d._ok=r.ok;return d;});}).then(function(d){setCloudStatus("cloud-users-status",d._ok?"Аккаунт удалён":(d.error||"Ошибка"),d._ok);loadCloudUsers();}).catch(function(){setCloudStatus("cloud-users-status","Ошибка",false);});}' +
  'function renderContent(entries,base){' +
  '  lastEntries=entries||[];lastBase=(base!==undefined)?base:currentPath;' +
  '  document.getElementById("file-area").innerHTML=' +
  '    (currentView==="grid"?fileGridHtml(lastEntries,lastBase):fileListHtml(lastEntries,lastBase));' +
  '}' +

  'function fileListHtml(files,base){' +
  '  if(!files.length)return \'<div style="color:#494454;padding:40px;text-align:center">\\u041f\\u0430\\u043f\\u043a\\u0430 \\u043f\\u0443\\u0441\\u0442\\u0430</div>\';' +
  '  var h=\'<div style="background:#1b1b1e;border:1px solid #494454;border-radius:12px;overflow:hidden">\';' +
  '  h+=\'<div class="file-row" style="font-size:12px;font-weight:600;color:#494454;text-transform:uppercase;letter-spacing:.05em;cursor:default;background:#131316"><div style="width:20px"><input class="select-check" type="checkbox" data-action="select-all" \'+(allVisibleSelected(files,base)?"checked":"")+\'></div><div style="width:28px"></div><div style="flex:1">\\u041d\\u0430\\u0437\\u0432\\u0430\\u043d\\u0438\\u0435</div><div style="width:100px;text-align:right">\\u0420\\u0430\\u0437\\u043c\\u0435\\u0440</div><div style="width:130px;text-align:right">\\u0418\\u0437\\u043c\\u0435\\u043d\\u0435\\u043d</div><div style="width:54px"></div></div>\';' +
  '  for(var i=0;i<files.length;i++){var f=files[i],fp=base?(base+"/"+f.name):f.name,checked=!!selectedItems[fp],isNew=isNewFile(fp),badge=isNew?\'<span class="new-badge">New</span>\':"";h+=\'<div class="file-row \'+(checked?"selected ":"")+(isNew?"is-new":"")+\'" draggable="true" data-fp="\'+H(fp)+\'" data-name="\'+H(f.name)+\'" data-dir="\'+f.isDir+\'">\';h+=\'<input class="select-check" type="checkbox" data-action="select-item" data-fp="\'+H(fp)+\'" data-name="\'+H(f.name)+\'" data-dir="\'+f.isDir+\'"\'+(checked?" checked":"")+">";h+=fileThumb(f.name,fp,f.isDir);if(f.isDir)h+=\'<div data-meta="\'+(f.fileCount!=null?H(f.fileCount+" items"):"Folder")+\'" style="flex:1;font-weight:500;color:#d0bcff;cursor:pointer;pointer-events:none">\'+H(f.name)+badge+"</div>";else h+=\'<div data-meta="\'+H(fmtSize(f.size)+" ? "+fmtDate(f.mtime))+\'" style="flex:1;color:#e4e1e6;pointer-events:none">\'+H(f.name)+badge+"</div>";h+=\'<div style="width:100px;text-align:right;font-size:13px;color:#958ea0;pointer-events:none">\'+fmtSize(f.size)+"</div>";h+=\'<div style="width:130px;text-align:right;font-size:12px;color:#494454;pointer-events:none">\'+fmtDate(f.mtime)+"</div>";h+=\'<button class="btn-ghost item-menu-btn" data-action="item-menu" data-fp="\'+H(fp)+\'" data-name="\'+H(f.name)+\'" data-dir="\'+f.isDir+\'" title="Actions"><span class="material-symbols-outlined">more_vert</span></button></div>\';}' +
  '  return h+"</div>";' +
  '}' +
  'function fileGridHtml(files,base){' +
  '  if(!files.length)return \'<div style="color:#494454;padding:40px;text-align:center">\\u041f\\u0430\\u043f\\u043a\\u0430 \\u043f\\u0443\\u0441\\u0442\\u0430</div>\';' +
  '  var h=\'<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:14px">\';' +
  '  for(var i=0;i<files.length;i++){var f=files[i],fp=base?(base+"/"+f.name):f.name,checked=!!selectedItems[fp],isNew=isNewFile(fp),badge=isNew?\'<span class="new-badge">New</span>\':"";h+=\'<div class="file-grid-item \'+(checked?"selected ":"")+(isNew?"is-new":"")+\'" draggable="true" data-fp="\'+H(fp)+\'" data-name="\'+H(f.name)+\'" data-dir="\'+f.isDir+\'" style="position:relative">\';h+=\'<input class="select-check" type="checkbox" data-action="select-item" data-fp="\'+H(fp)+\'" data-name="\'+H(f.name)+\'" data-dir="\'+f.isDir+\'" style="position:absolute;top:10px;left:10px"\'+(checked?" checked":"")+">";h+=fileThumb(f.name,fp,f.isDir);h+=\'<div style="font-size:13px;font-weight:700;color:\'+(f.isDir?"#d0bcff":"#e4e1e6")+\';word-break:break-word;max-width:150px;text-align:left;pointer-events:none">\'+H(f.name)+badge+"</div>";h+=\'<div style="font-size:11px;color:#958ea0;pointer-events:none">\'+(f.isDir?(fmtSize(f.size)+" ? "+(f.fileCount||0)+" items"):fmtSize(f.size))+"</div>";h+=\'<button class="btn-ghost item-menu-btn" data-action="item-menu" data-fp="\'+H(fp)+\'" data-name="\'+H(f.name)+\'" data-dir="\'+f.isDir+\'" title="Actions" style="position:absolute;right:10px;top:10px"><span class="material-symbols-outlined">more_vert</span></button></div>\';}' +
  '  return h+"</div>";' +
  '}' +

  'function loadRecent(){' +
  '  clearSelection(false);setSectionChrome("recent");currentPath="__recent__";savePath("__recent__");setNavActive("nav-recent");document.getElementById("file-area").innerHTML=\'<div style="color:#958ea0;padding:40px;text-align:center">\\u0417\\u0430\\u0433\\u0440\\u0443\\u0437\\u043a\\u0430...</div>\';renderBreadcrumb("");' +
  '  fetch("/api/fm/recent").then(function(r){return r.json();})' +
  '  .then(function(d){if(d.error){document.getElementById("file-area").innerHTML=\'<div style="color:#ffb4ab;padding:24px">\'+H(d.error)+"</div>";return;}var entries=(d.entries||[]).map(function(e){return{name:e.relPath,size:e.size,mtime:e.mtime,isDir:false};});lastEntries=entries;lastBase="";document.getElementById("file-area").innerHTML=\'<div style="font-size:13px;color:#958ea0;margin-bottom:12px">\\u041d\\u0435\\u0434\\u0430\\u0432\\u043d\\u0438\\u0435 \\u0444\\u0430\\u0439\\u043b\\u044b</div>\'+fileListHtml(entries,"");})' +
  '  .catch(function(){document.getElementById("file-area").innerHTML=\'<div style="color:#ffb4ab;padding:24px">\\u041e\\u0448\\u0438\\u0431\\u043a\\u0430</div>\';});' +
  '}' +

  'function loadUrlHistory(){' +
  '  clearSelection(false);setSectionChrome("url-history");currentPath="__url_history__";savePath("__url_history__");setNavActive("nav-url-history");renderBreadcrumb("");' +
  '  document.getElementById("file-area").innerHTML=\'<div style="color:#958ea0;padding:40px;text-align:center">\\u0417\\u0430\\u0433\\u0440\\u0443\\u0437\\u043a\\u0430 \\u0438\\u0441\\u0442\\u043e\\u0440\\u0438\\u0438...</div>\';' +
  '  fetch("/api/fm/media-jobs?scope=history").then(function(r){return r.json();})' +
  '  .then(function(items){items=Array.isArray(items)?items:[];if(!items.length){document.getElementById("file-area").innerHTML=\'<div style="color:#494454;padding:40px;text-align:center">\\u0418\\u0441\\u0442\\u043e\\u0440\\u0438\\u044f URL \\u043f\\u043e\\u043a\\u0430 \\u043f\\u0443\\u0441\\u0442\\u0430\\u044f</div>\';return;}var h=\'<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px"><div style="font-size:18px;font-weight:800;color:#e4e1e6">\\u0418\\u0441\\u0442\\u043e\\u0440\\u0438\\u044f URL-\\u0437\\u0430\\u0433\\u0440\\u0443\\u0437\\u043e\\u043a</div><button class="btn-ghost" data-action="nav-home"><span class="material-symbols-outlined">folder</span> \\u041c\\u043e\\u0438 \\u0444\\u0430\\u0439\\u043b\\u044b</button></div>\';h+=\'<div style="border:1px solid #494454;border-radius:12px;overflow:hidden">\';for(var i=0;i<items.length;i++){var x=items[i],ok=x.status==="complete",bad=x.status==="error"||x.status==="cancelled";h+=\'<div class="history-row"><div style="min-width:0"><div class="history-name">\'+H(x.name||x.file||"Media download")+\'</div><div class="history-meta">\'+H(x.url||"")+\'</div></div><div class="history-meta">\'+H((x.mode||"media")+" / "+(x.status||"unknown"))+\'</div><div class="history-meta">\'+Math.round(x.progress||0)+\'%</div><div style="display:flex;gap:8px;justify-content:flex-end">\';h+=\'<button class="btn-ghost" data-action="retry-url" data-url="\'+H(x.url||"")+\'" title="Повторить"><span class="material-symbols-outlined">refresh</span></button>\';if(ok)h+=\'<button class="btn-ghost" data-action="navigate" data-fp="\'+H(x.folder||"")+\'" title="Open folder"><span class="material-symbols-outlined">folder_open</span></button>\';if(bad&&x.error)h+=\'<button class="btn-ghost" data-action="show-history-error" data-error="\'+H(x.error)+\'" title="Error"><span class="material-symbols-outlined">error</span></button>\';h+=\'</div></div>\';}h+=\'</div>\';document.getElementById("file-area").innerHTML=h;})' +
  '  .catch(function(){document.getElementById("file-area").innerHTML=\'<div style="color:#ffb4ab;padding:24px">\\u041e\\u0448\\u0438\\u0431\\u043a\\u0430 \\u0438\\u0441\\u0442\\u043e\\u0440\\u0438\\u0438</div>\';});' +
  '}' +

  'function doSearch(q){' +
  '  if(currentPath==="__dashboard__"||currentPath==="__recent__"||currentPath==="__url_history__"||currentPath==="__settings__")return;' +
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
  'function openUrlModal(prefill){document.getElementById("modal-url").style.display="flex";document.getElementById("url-dl-inp").value=prefill||"";document.getElementById("url-name-inp").value="";document.getElementById("url-mode-inp").value="file";document.getElementById("url-status").textContent="";setTimeout(function(){document.getElementById("url-dl-inp").focus();},20);}' +
  'function closeUrlModal(){document.getElementById("modal-url").style.display="none";}' +
  'function stripInputMediaExt(name){return String(name||"").replace(/\\.(mp4|webm|mkv|mov|m4v|mp3|m4a|opus|ogg|wav|flac|aac)$/i,"");}' +
  'function addUrlDownload(){var url=document.getElementById("url-dl-inp").value.trim();var name=document.getElementById("url-name-inp").value.trim();var mode=document.getElementById("url-mode-inp").value;var st=document.getElementById("url-status");var folder=activePath();if(!url){st.textContent="Вставь URL";return;}var media=mode!=="file";if(media)name=stripInputMediaExt(name);st.textContent=media?"Запускаю медиа-загрузку...":"Добавляю загрузку...";fetch(media?"/api/fm/media":"/api/fm/add-url",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url:url,filename:name,path:folder,mode:mode})}).then(function(r){return r.json();}).then(function(d){if(d.ok){var gid=d.gid||(d.job&&d.job.id);if(gid){knownMediaStatuses[gid]="active";markPendingUrlJob(gid,folder);}st.textContent=media?"Медиа-загрузка запущена":"Загрузка добавлена";closeUrlModal();loadTransfers();}else st.textContent=d.error||"Ошибка";}).catch(function(){st.textContent="Ошибка";});}' +
  'function closePreview(){if(window.previewPlyrInstance){window.previewPlyrInstance.destroy();window.previewPlyrInstance=null;}document.getElementById("preview-panel").classList.remove("open");document.getElementById("preview-body").classList.remove("media-preview");document.getElementById("preview-body").innerHTML="";document.getElementById("preview-info").innerHTML="";previewKind="";previewSrc="";}' +
  'function metaRow(label,value){return \'<div class="meta-row"><div class="meta-lbl">\'+H(label)+\'</div><div class="meta-val">\'+(value||"—")+\'</div></div>\';}' +
  'function renderPreviewInfo(fp,name){var info=document.getElementById("preview-info");info.innerHTML=\'<div style="font-size:12px;color:#958ea0">Загрузка информации...</div>\';fetch("/api/fm/meta?path="+encodeURIComponent(fp)).then(function(r){return r.json();}).then(function(m){if(m.error){info.innerHTML=metaRow("Имя",name)+metaRow("Путь",fp);return;}var links=m.publicLinks||[];var linkHtml=links.length?links.map(function(x){var full=window.location.origin+x.url;return \'<div style="display:flex;align-items:center;gap:6px;justify-content:flex-end"><a href="\'+H(x.url)+\'" target="_blank" style="color:#d2bbff;min-width:0;overflow:hidden;text-overflow:ellipsis">\'+H(full)+\'</a><button class="btn-ghost" data-action="qr-link" data-url="\'+H(full)+\'" style="padding:2px 7px;min-height:24px;font-size:11px">QR</button></div>\';}).join(""):"Нет";var h="";h+=metaRow("Имя",m.name||name);h+=metaRow("Путь",m.path||fp);h+=metaRow("Размер",fmtSize(m.size));h+=metaRow("Тип",m.ext?m.ext.slice(1).toUpperCase():"Файл");h+=metaRow("Загружен",fmtDateTime(m.created));h+=metaRow("Изменён",fmtDateTime(m.mtime));h+=metaRow("Публичная ссылка",linkHtml);info.innerHTML=h;}).catch(function(){info.innerHTML=metaRow("Имя",name)+metaRow("Путь",fp);});}' +
  'function fitPlyrToVideo(media,player){if(!media||!player)return;var container=player.elements&&player.elements.container;if(!container)return;function fit(){var vw=media.videoWidth||0,vh=media.videoHeight||0;if(!vw||!vh)return;var host=media.closest(".preview-media-wrap")||media.closest(".mv-stage")||container.parentElement;if(!host)return;var maxW=host.clientWidth||window.innerWidth,maxH=host.clientHeight||Math.round(window.innerHeight*.72);if(host.classList&&host.classList.contains("mv-stage"))maxH=Math.max(220,maxH-4);else maxH=Math.min(maxH||Math.round(window.innerHeight*.72),Math.round(window.innerHeight*.72));var ratio=vw/vh,w=maxW,h=w/ratio;if(h>maxH){h=maxH;w=h*ratio;}container.style.width=Math.max(180,Math.floor(w))+"px";container.style.maxWidth="100%";container.style.aspectRatio=vw+" / "+vh;var wrap=container.querySelector(".plyr__video-wrapper");if(wrap){wrap.style.aspectRatio=vw+" / "+vh;wrap.style.height=Math.floor(h)+"px";}media.style.objectFit="contain";}media.addEventListener("loadedmetadata",fit,{once:false});window.addEventListener("resize",fit);setTimeout(fit,80);setTimeout(fit,400);}\n' +
  'function initPlyr(selector,isVideo,key){if(typeof Plyr==="undefined")return null;var opts={controls:isVideo?["play-large","play","progress","current-time","duration","mute","volume","captions","settings","pip","airplay","fullscreen"]:["play","progress","current-time","duration","mute","volume"],settings:["captions","quality","speed","loop"],keyboard:{focused:true,global:false},tooltips:{controls:true,seek:true}};var p=new Plyr(selector,opts);if(isVideo)fitPlyrToVideo(document.querySelector(selector),p);p.on("ready",function(e){var t=localStorage.getItem(key);if(t)e.detail.plyr.currentTime=parseFloat(t);});p.on("timeupdate",function(e){localStorage.setItem(key,e.detail.plyr.currentTime);});return p;}\n' +
  'function openPreview(fp,name,isDir){if(isDir){navigateTo(fp);return;}if(window.previewPlyrInstance){window.previewPlyrInstance.destroy();window.previewPlyrInstance=null;}previewFp=fp;previewName=name;previewKind="";previewSrc="";var panel=document.getElementById("preview-panel");var body=document.getElementById("preview-body");document.getElementById("preview-title").textContent=name;panel.classList.add("open");body.classList.remove("media-preview");body.innerHTML="";renderPreviewInfo(fp,name);var ext=(name.split(".").pop()||"").toLowerCase();var src="/api/fm/preview?path="+encodeURIComponent(fp);if(["png","jpg","jpeg","gif","webp","svg","bmp"].includes(ext)){previewKind="image";previewSrc=src;body.classList.add("media-preview");body.innerHTML=`<div id="preview-media-wrap" class="preview-media-wrap"><img class="preview-media" src="${src}" alt="${H(name)}"></div>`;return;}if(["mp4","webm","ogg","mov","mkv"].includes(ext)){previewKind="video";previewSrc=src;body.classList.add("media-preview");body.innerHTML=`<div id="preview-media-wrap" class="preview-media-wrap"><video id="preview-plyr" src="${src}" playsinline controls></video></div>`;setTimeout(function(){try{window.previewPlyrInstance=initPlyr("#preview-plyr",true,"plyr_time_"+src);}catch(e){console.error(e);}},50);return;}if(["mp3","wav","m4a","flac","aac","oga"].includes(ext)){previewKind="audio";previewSrc=src;body.classList.add("media-preview");body.innerHTML=`<div id="preview-media-wrap" class="preview-media-wrap"><audio id="preview-plyr" src="${src}" playsinline controls></audio></div>`;setTimeout(function(){try{window.previewPlyrInstance=initPlyr("#preview-plyr",false,"plyr_time_"+src);}catch(e){console.error(e);}},50);return;}if(ext==="pdf"){body.innerHTML=`<iframe src="${src}" style="width:100%;height:70vh;border:0;border-radius:10px"></iframe>`;return;}if(["txt","log","md","json","csv","js","css","html","xml","yml","yaml","ini","conf"].includes(ext)){body.textContent="Загрузка предпросмотра...";fetch(src).then(function(r){return r.text();}).then(function(t){body.innerHTML=`<pre style="white-space:pre-wrap;font-size:12px;line-height:1.55;margin:0">${H(t)}</pre>`;}).catch(function(){body.textContent="Не удалось загрузить предпросмотр";});return;}body.innerHTML=`<div style="padding:32px;text-align:center;color:#958ea0">Предпросмотр недоступен<br><br><a class="btn-primary" href="/api/fm/download?path=${encodeURIComponent(fp)}" download style="display:inline-block;text-decoration:none">Скачать файл</a></div>`;}' +
  'function openPreviewShell(fp,name){if(window.previewPlyrInstance){window.previewPlyrInstance.destroy();window.previewPlyrInstance=null;}previewFp=fp;previewName=name;previewKind="";previewSrc="";var panel=document.getElementById("preview-panel"),body=document.getElementById("preview-body");document.getElementById("preview-title").textContent=name;panel.classList.add("open");body.classList.remove("media-preview");body.innerHTML="";renderPreviewInfo(fp,name);return body;}' +
  'function renderDocPreview(fp,name){var body=openPreviewShell(fp,name);body.innerHTML=\'<div style="color:#958ea0;padding:20px">Загрузка документа...</div>\';fetch("/api/fm/doc-preview?path="+encodeURIComponent(fp)).then(function(r){return r.json();}).then(function(d){if(!d.ok){body.innerHTML=\'<div style="padding:24px;color:#ffb4ab">\'+H(d.error||"Не удалось открыть документ")+\'</div>\';return;}if(d.type==="sheet"){var sheets=d.sheets||[];if(!sheets.length){body.innerHTML=\'<div style="padding:24px;color:#958ea0">В таблице нет листов</div>\';return;}var h=\'<div class="doc-tabs">\';for(var i=0;i<sheets.length;i++)h+=\'<button class="doc-tab" data-sheet="\'+i+\'">\'+H(sheets[i].name)+\'</button>\';h+=\'</div><div id="sheet-preview" class="doc-preview">\'+(sheets[0].html||"")+\'</div>\';body.innerHTML=h;body.querySelectorAll("[data-sheet]").forEach(function(btn){btn.addEventListener("click",function(){var idx=parseInt(btn.dataset.sheet,10)||0;document.getElementById("sheet-preview").innerHTML=sheets[idx].html||"";});});return;}body.innerHTML=\'<div class="doc-preview">\'+(d.html||"")+\'</div>\';}).catch(function(){body.innerHTML=\'<div style="padding:24px;color:#ffb4ab">Ошибка предпросмотра</div>\';});}' +
  'function renderArchivePreview(fp,name){var body=openPreviewShell(fp,name);body.innerHTML=\'<div style="color:#958ea0;padding:20px">Читаю архив...</div>\';fetch("/api/fm/archive/list?path="+encodeURIComponent(fp)).then(function(r){return r.json();}).then(function(d){if(!d.ok){body.innerHTML=\'<div style="padding:24px;color:#ffb4ab">\'+H(d.error||"Не удалось открыть архив")+\'<div style="margin-top:8px;color:#958ea0;font-size:12px">\'+H(d.details||"")+\'</div></div>\';return;}var items=d.entries||[];if(!items.length){body.innerHTML=\'<div style="padding:24px;color:#958ea0">Архив пуст</div>\';return;}var h=\'<div style="display:flex;justify-content:space-between;gap:10px;margin-bottom:10px;color:#958ea0;font-size:12px"><span>\'+items.length+\' items</span><a class="btn-ghost" href="/api/fm/download?path=\'+encodeURIComponent(fp)+\'" download style="text-decoration:none;padding:4px 10px;min-height:28px">Скачать архив</a></div><table class="archive-table"><tbody>\';items.forEach(function(x){var icon=x.isDir?"folder":"draft";var cls=x.isDir?"archive-path archive-dir":"archive-path";h+=\'<tr><td style="width:28px"><span class="material-symbols-outlined" style="font-size:18px">\'+icon+\'</span></td><td><div class="\'+cls+\'" title="\'+H(x.path)+\'">\'+H(x.path)+\'</div></td><td style="width:76px;color:#958ea0;white-space:nowrap">\'+(x.isDir?"":fmtSize(x.size||0))+\'</td><td style="width:42px;text-align:right">\'+(x.isDir?"":\'<a class="btn-ghost" href="/api/fm/archive/download?path=\'+encodeURIComponent(fp)+\'&entry=\'+encodeURIComponent(x.path)+\'" download style="padding:3px 8px;min-height:24px;text-decoration:none">↓</a>\')+\'</td></tr>\';});h+=\'</tbody></table>\';body.innerHTML=h;}).catch(function(){body.innerHTML=\'<div style="padding:24px;color:#ffb4ab">Ошибка чтения архива</div>\';});}' +
  'var cloudBasicOpenPreview=openPreview;openPreview=function(fp,name,isDir){if(isDir){navigateTo(fp);return;}var ext=(name.split(".").pop()||"").toLowerCase();if(["docx","xlsx","csv"].includes(ext))return renderDocPreview(fp,name);if(["zip","rar","7z","tar","gz","bz2","xz"].includes(ext))return renderArchivePreview(fp,name);return cloudBasicOpenPreview(fp,name,isDir);};' +
  'window.plyrInstance = null;' +
  'window.previewPlyrInstance = null;' +
  'function closeMediaViewer(){' +
  '  var v=document.getElementById("media-viewer");' +
  '  if(window.plyrInstance){ window.plyrInstance.destroy(); window.plyrInstance=null; }' +
  '  var media=document.getElementById("mv-media");' +
  '  if(media&&media.pause)media.pause();' +
  '  v.classList.remove("open");' +
  '  document.getElementById("mv-stage").innerHTML="";' +
  '  document.getElementById("mv-bottom").innerHTML="";' +
  '}' +
  'function openMediaViewer(){' +
  '  if(!previewSrc||!previewKind)return;' +
  '  mvZoom=1; document.getElementById("mv-title").textContent=previewName||"Media";' +
  '  var v=document.getElementById("media-viewer"),stage=document.getElementById("mv-stage"),bottom=document.getElementById("mv-bottom");' +
  '  if(previewKind==="image"){' +
  '    stage.innerHTML=`<img id="mv-media" src="${previewSrc}" alt="${H(previewName)}">`;' +
  '    bottom.innerHTML=\'<button class="mv-icon" data-action="mv-zoom-out"><span class="material-symbols-outlined">zoom_out</span></button><button class="mv-icon" data-action="mv-fit"><span class="material-symbols-outlined">fit_screen</span></button><button class="mv-icon" data-action="mv-zoom-in"><span class="material-symbols-outlined">zoom_in</span></button><div style="flex:1"></div><div class="mv-time">Image viewer</div>\';' +
  '  } else {' +
  '    stage.innerHTML=`<${previewKind==="audio"?"audio":"video"} id="mv-media" src="${previewSrc}" playsinline controls style="max-height:100%"></${previewKind==="audio"?"audio":"video"}>`;' +
  '    bottom.innerHTML="";' +
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
  '           if(savedTime) e.detail.plyr.currentTime = parseFloat(savedTime);' +
  '        });' +
  '        window.plyrInstance.on("timeupdate", function(e){ ' +
  '           localStorage.setItem("plyr_time_" + previewSrc, e.detail.plyr.currentTime);' +
  '        });' +
  '      } catch(err) { console.error("Plyr failed to init:", err); }' +
  '    }, 150);' +
  '  }' +
  '  v.classList.add("open");' +
  '}' +
  'function bindMediaControls(){}' +
  'function mediaViewerAction(action){var m=document.getElementById("mv-media"),viewer=document.getElementById("media-viewer");if(action==="mv-close")return closeMediaViewer();if(action==="mv-download"&&previewFp)window.location.href="/api/fm/download?path="+encodeURIComponent(previewFp);if(action==="mv-share"&&previewFp)shareOne(previewFp);if(action==="mv-zoom-in"&&m){mvZoom=Math.min(4,mvZoom+.25);m.style.transform="scale("+mvZoom+")";}if(action==="mv-zoom-out"&&m){mvZoom=Math.max(.25,mvZoom-.25);m.style.transform="scale("+mvZoom+")";}if(action==="mv-fit"&&m){mvZoom=1;m.style.transform="scale(1)";}}' +
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
  '  else if(action==="download-preview"){if(previewFp)window.location.href="/api/fm/download?path="+encodeURIComponent(previewFp);}' +
  '  else if(action==="share-preview"){if(previewFp)shareOne(previewFp);}' +
  '  else if(action==="transfer-pause"){fetch("/api/downloads/"+encodeURIComponent(el.dataset.gid)+"/pause",{method:"POST"}).then(loadTransfers);}' +
  '  else if(action==="transfer-resume"){fetch("/api/downloads/"+encodeURIComponent(el.dataset.gid)+"/resume",{method:"POST"}).then(loadTransfers);}' +
  '  else if(action==="transfer-remove"){if(confirm("Убрать загрузку?"))fetch("/api/downloads/"+encodeURIComponent(el.dataset.gid),{method:"DELETE"}).then(loadTransfers);}' +
  '  else if(action==="media-cancel"){if(confirm("Отменить медиа-загрузку?"))fetch("/api/fm/media-jobs/"+encodeURIComponent(el.dataset.job),{method:"DELETE"}).then(loadTransfers);}' +
  '  else if(action==="nav-home"||action==="nav-dashboard"){loadDashboard();}' +
  '  else if(action==="nav-files"){navigateTo("");}' +
  '  else if(action==="nav-recent"){loadRecent();}' +
  '  else if(action==="nav-url-history"){loadUrlHistory();}' +
  '  else if(action==="nav-settings"){loadCloudSettings();}' +
  '  else if(action==="settings-save-retention"){saveCloudRetention();}' +
  '  else if(action==="settings-save-profile"){saveCloudProfile();}' +
  '  else if(action==="settings-speedtest"){runSpeedTest();}' +
  '  else if(action==="settings-notif"){requestCloudNotif();}' +
  '  else if(action==="settings-load-token"){loadCloudToken();}' +
  '  else if(action==="settings-copy-token"){copyCloudToken();}' +
  '  else if(action==="settings-reset-token"){resetCloudToken();}' +
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
  '  setTimeout(function(){if(dragEl)dragEl.classList.add("dragging");},0);' +
  '});' +

  /* ── DRAG END ── */
  'document.addEventListener("dragend",function(){' +
  '  if(dragEl)dragEl.classList.remove("dragging");' +
  '  dragEl=null;dragFp=null;' +
  '  clearDragOver();' +
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
  '  var dropTarget=e.target.closest("[data-drop-path]");' +
  '  if(dropTarget){' +
  '    e.preventDefault();' +
  '    var destDrop=dropTarget.dataset.dropPath||"";' +
  '    var fromDrop=dragFp,nameDrop=dragName;' +
  '    dragFp=null;' +
  '    moveItemTo(fromDrop,nameDrop,destDrop);' +
  '    return;' +
  '  }' +
  '  var target=e.target.closest("[data-dir=\'true\'][data-fp]");' +
  '  if(!target||target.dataset.fp===dragFp){dragFp=null;return;}' +
  '  e.preventDefault();' +
  '  var destFp=target.dataset.fp;' +
  '  var moveFp=dragFp,moveName=dragName;' +
  '  dragFp=null;' +
  '  moveItemTo(moveFp,moveName,destFp);' +
  '});' +

  /* ── KEYBOARD ── */
  'document.addEventListener("keydown",function(e){' +
  '  if(e.key==="Escape"){hideCtxMenu();closeMkdirModal();closeRenameModal();closeUrlModal();closeShareModal();closeShareManager();closeQrModal();closeMediaViewer();closePreview();}' +
  '  if(e.key==="Enter"){' +
  '    if(document.getElementById("modal-mkdir").style.display!=="none")createFolder();' +
  '    else if(document.getElementById("modal-rename").style.display!=="none")doRename();' +
  '    else if(document.getElementById("modal-url").style.display!=="none")addUrlDownload();' +
  '    else if(document.getElementById("modal-share").style.display!=="none")confirmShare();' +
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
  'document.addEventListener("keydown",function(e){if(e.key==="Enter"&&document.activeElement&&["dash-url-inp","dash-name-inp"].includes(document.activeElement.id)){addDashboardUrlDownload();}});' +
  'window.addEventListener("beforeunload",function(e){if(uploadBusy){e.preventDefault();e.returnValue="";return "";}});' +

  'applyTheme();' +
  '(function(){var h=parseHash();if(h){if(h.type==="dashboard")loadDashboard();else if(h.type==="recent")loadRecent();else if(h.type==="url-history")loadUrlHistory();else if(h.type==="settings")loadCloudSettings();else navigateTo(h.path||"");return;}var saved=localStorage.getItem("fm-path");if(saved===null)loadDashboard();else if(saved==="__dashboard__")loadDashboard();else if(saved==="__recent__")loadRecent();else if(saved==="__url_history__")loadUrlHistory();else if(saved==="__settings__")loadCloudSettings();else navigateTo(saved||"");})();' +
  'loadDisk();' +
  'loadTransfers();' +
  'checkConnection(true);' +
  'setInterval(loadTransfers,5000);' +
  'setInterval(loadDisk,60000);' +
  'setInterval(function(){checkConnection(true);},15000);' +
  '</script>' +
  '</body></html>';
}
