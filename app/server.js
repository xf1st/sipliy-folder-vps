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

const config = require('./config');
const db = require('./db');
const utils = require('./utils');
const media = require('./media');
const templates = require('./templates');
const sse = require('./sse');

// Destructure from config
const {
  PORT, SITE_VERSION, DOWNLOADS_ROOT, VT_API_KEY, VT_API, TG_TOKEN, TG_BOT_NAME,
  SHARES_FILE, MEDIA_JOBS_FILE, TOKENS_FILE, SETTINGS_FILE, YTDLP_COOKIES_FILE,
  TG_USERS_FILE, USERS_FILE, SECRET_FILE, UPLOADS_FILE, ACTIVITY_FILE,
  VAPID_FILE, PUSH_SUBS_FILE, FORBIDDEN_UPLOAD_EXT, getUserCookiesPath
} = config;

// Destructure from db
const {
  writeJsonAtomic, loadShares, saveShares, shareOptionsFromBody, shareIsExpired,
  loadTgUsers, saveTgUsers, loadTokens, saveTokens, loadSettings, saveSettings,
  getUserRetention, getUserMaxTgSize, getUserAccentHex, getUserQuotaGb, getUserDiskUsedBytes,
  hashPassword, verifyPassword, getSessionSecret, loadUsers, saveUsers, isAdmin,
  loadUploads, saveUploads, registerUploadedFile, isUploadedFile, removeUploadedFile,
  loadActivity, logActivity
} = db;

// Destructure from utils
const {
  htmlEscape, fmtBytes, isUriSafe, loginGate, loginFail, loginOk, multerFileFilter,
  auth, authToken, userDir, aria2, newestMediaFile, mediaExtOk, stripKnownMediaExt,
  ensureMediaExtension, validateMediaFile, buildMediaFormat, filenameWithUrlExtension,
  fmResolve, fmRelative, shareOwner, shareCreated, sharePathMatches, shareFilePath,
  fmDirSize, fmArchiveDir, fmCollectItems
} = utils;

// Destructure from media
const {
  mediaProcesses, loadMediaJobs, saveMediaJobs, mediaJobPublic, syncAriaDownloadJobs,
  ytDlpAvailable, startMediaJob
} = media;

// Destructure from templates
const {
  sharePasswordPage, shareNotFoundPage, sharePreviewPage, landingPage, privacyPage,
  loginPage, faqPage, cloudPage
} = templates;

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('/opt/vps-downloader/public', { maxAge: '7d' }));
app.use(session({
  store: new FileStore({ path: '/opt/vps-downloader/sessions', ttl: 30 * 24 * 60 * 60 }),
  secret: getSessionSecret(),
  resave: true,
  saveUninitialized: false,
  rolling: true,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' },
}));

// ─── Routes ─────────────────────────────────────────────────────
app.get('/faq.html', auth, (req, res) => res.send(faqPage()));
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
  if (user && verifyPassword(password, user)) {
    // Миграция: если пароль хранится в старом plaintext-формате — хешируем на лету
    if (!user.passwordHash && user.password) {
      const { passwordHash, passwordSalt } = hashPassword(password);
      user.passwordHash = passwordHash;
      user.passwordSalt = passwordSalt;
      delete user.password;
      users[username] = user;
      saveUsers(users);
    }
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
app.get('/', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/cloud');
  res.send(landingPage());
});
app.get('/privacy', (req, res) => res.send(privacyPage()));

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
      const { execFileSync } = require('child_process');
      const out = execFileSync('df', ['-Pk', root], { timeout: 2000, encoding: 'utf8' });
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
// ─── SSE: real-time job updates ──────────────────────────────────────────────
app.get('/api/events', auth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();
  res.write(': connected\n\n');
  sse.addClient(req.session.user, res);
  const keepalive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(keepalive); }
  }, 25000);
  req.on('close', () => {
    clearInterval(keepalive);
    sse.removeClient(req.session.user, res);
  });
});

// ─── Web Push ────────────────────────────────────────────────────────────────
let webpush = null;
let vapidKeys = null;

function initWebPush() {
  try {
    webpush = require('web-push');
    try {
      vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
    } catch {
      vapidKeys = webpush.generateVAPIDKeys();
      fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys));
    }
    webpush.setVapidDetails('mailto:admin@vps.local', vapidKeys.publicKey, vapidKeys.privateKey);
    console.log('✓ Web Push инициализирован');
  } catch (e) {
    console.warn('web-push недоступен, Web Push отключён:', e.message);
    webpush = null;
  }
}
initWebPush();
// Hook для media.js (избегаем circular dependency)
global._pushJobDone = (job) => {
  sendPushToUser(job.user, {
    title: 'Загрузка завершена',
    body: job.name || job.file || 'Файл готов',
    tag: 'job-' + job.id,
    url: '/',
  }).catch(() => {});
};

function loadPushSubs() {
  try { return JSON.parse(fs.readFileSync(PUSH_SUBS_FILE, 'utf8')); } catch { return {}; }
}
function savePushSubs(s) {
  try { fs.writeFileSync(PUSH_SUBS_FILE, JSON.stringify(s)); } catch {}
}

async function sendPushToUser(username, payload) {
  if (!webpush) return;
  const subs = loadPushSubs();
  const list = subs[username] || [];
  const expired = [];
  for (const sub of list) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) expired.push(sub.endpoint);
    }
  }
  if (expired.length) {
    subs[username] = list.filter(s => !expired.includes(s.endpoint));
    savePushSubs(subs);
  }
}

app.get('/api/push/vapid-key', auth, (req, res) => {
  if (!vapidKeys) return res.json({ enabled: false });
  res.json({ enabled: true, publicKey: vapidKeys.publicKey });
});

app.post('/api/push/subscribe', auth, (req, res) => {
  const { subscription } = req.body;
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Invalid' });
  const subs = loadPushSubs();
  if (!subs[req.session.user]) subs[req.session.user] = [];
  if (!subs[req.session.user].some(s => s.endpoint === subscription.endpoint))
    subs[req.session.user].push(subscription);
  savePushSubs(subs);
  res.json({ ok: true });
});

app.delete('/api/push/subscribe', auth, (req, res) => {
  const { endpoint } = req.body || {};
  const subs = loadPushSubs();
  if (subs[req.session.user])
    subs[req.session.user] = subs[req.session.user].filter(s => s.endpoint !== endpoint);
  savePushSubs(subs);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  const users = loadUsers();
  const me = users[req.session.user] || {};
  res.json({
    username: req.session.user,
    label: me.label || req.session.user,
    isAdmin: !!me.isAdmin,
    quotaGb: getUserQuotaGb(req.session.user),
    diskUsedBytes: getUserDiskUsedBytes(req.session.user),
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
    const ytdlpIntermediate = name => /\.\w*f\d+\.(mp4|m4a|webm|mkv|opus|wav|aac)$/i.test(name);
    const files = fs.readdirSync(dir)
      .filter(name => {
        try { return fs.statSync(path.join(dir, name)).isFile() && !ytdlpIntermediate(name); } catch { return false; }
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
  const quality = ['2160','1440','1080','720','480','360'].includes(req.body.quality) ? req.body.quality : '';
  if (!dlUrl) return res.status(400).json({ error: 'URL empty' });
  if (!isUriSafe(dlUrl)) return res.status(400).json({ error: 'URL заблокирован (приватный/локальный адрес или неподдерживаемая схема)' });
  const dir = userDir(req.tokenUser);
  ytDlpAvailable((available) => {
    if (!available) return res.status(500).json({ error: 'yt-dlp не установлен на сервере' });
    try {
      const job = startMediaJob({ username: req.tokenUser, url: dlUrl, dir, relPath: '', mode, filename, quality });
      res.json({ ok: true, job: mediaJobPublic(job) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});
// Статус медиа-задания для расширения
app.options('/api/ext/media-jobs/:id', (req, res) => res.set(EXT_CORS).sendStatus(204));
app.get('/api/ext/media-jobs/:id', extCors, authToken, (req, res) => {
  const jobs = loadMediaJobs();
  const job = jobs[req.params.id];
  if (!job || job.user !== req.tokenUser) return res.json({ ok: true, job: null });
  res.json({ ok: true, job: mediaJobPublic(job) });
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
// Тема аккаунта для расширения (Bearer-auth)
app.options('/api/ext/theme', (req, res) => res.set(EXT_CORS).sendStatus(204));
app.get('/api/ext/theme', extCors, authToken, (req, res) => {
  const accentHex = getUserAccentHex(req.tokenUser);
  res.json({ accentHex: accentHex || '#a078ff' });
});
// Версия расширения (без авторизации — для OTA проверки)
const EXT_VERSION = '2.16.1';
app.get('/api/ext/version', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*').json({
    version: EXT_VERSION,
    downloadUrl: req.protocol + '://' + req.get('host') + '/ext/update',
    changelog: 'Добавлена передача cookies при скачивании по ссылке из контекстного меню (исправление ошибок авторизации)',
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
  res.json(Object.entries(users).map(([u, d]) => ({ username: u, label: d.label, isAdmin: !!d.isAdmin, quotaGb: getUserQuotaGb(u) })));
});
app.post('/api/users', auth, (req, res) => {
  if (!isAdmin(req.session.user)) return res.status(403).json({ error: 'Forbidden' });
  const { username, password, label } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Логин и пароль обязательны' });
  if (!/^[a-z0-9_]{2,32}$/.test(username)) return res.status(400).json({ error: 'Логин: только строчные буквы, цифры, _ (2–32 символа)' });
  if (password.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });
  const users = loadUsers();
  if (users[username]) return res.status(409).json({ error: 'Пользователь уже существует' });
  const { passwordHash, passwordSalt } = hashPassword(password);
  users[username] = { passwordHash, passwordSalt, label: label || username, isAdmin: false };
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
app.patch('/api/users/:username', auth, (req, res) => {
  if (!isAdmin(req.session.user)) return res.status(403).json({ error: 'Forbidden' });
  const target = req.params.username;
  const users = loadUsers();
  if (!users[target]) return res.status(404).json({ error: 'Пользователь не найден' });
  const s = loadSettings();
  if (req.body.quotaGb !== undefined) {
    const raw = req.body.quotaGb;
    const v = (raw === null || raw === '' || raw === 0) ? null : parseFloat(raw);
    if (v !== null && (isNaN(v) || v <= 0)) return res.status(400).json({ error: 'Неверное значение квоты' });
    if (typeof s[target] !== 'object') s[target] = { retention: 7 };
    s[target].quotaGb = v;
    saveSettings(s);
  }
  if (req.body.label !== undefined) {
    users[target].label = String(req.body.label || '').trim() || target;
    saveUsers(users);
  }
  res.json({ ok: true });
});
app.post('/api/change-password', auth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Новый пароль минимум 6 символов' });
  const users = loadUsers();
  const me = users[req.session.user];
  if (!me) return res.status(404).json({ error: 'Пользователь не найден' });
  if (!verifyPassword(currentPassword, me)) return res.status(403).json({ error: 'Неверный текущий пароль' });
  const { passwordHash, passwordSalt } = hashPassword(newPassword);
  me.passwordHash = passwordHash;
  me.passwordSalt = passwordSalt;
  delete me.password; // удаляем старый plaintext если был
  users[req.session.user] = me;
  saveUsers(users);
  res.json({ ok: true });
});
app.get('/api/settings', auth, (req, res) => {
  res.json({
    retention: getUserRetention(req.session.user),
    tgLimit: getUserMaxTgSize(req.session.user),
    accentHex: getUserAccentHex(req.session.user),
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
  if (req.body.accentHex !== undefined) {
    const h = String(req.body.accentHex || '').trim();
    if (h && !/^#[0-9a-fA-F]{6}$/.test(h)) return res.status(400).json({ error: 'Invalid accentHex' });
    if (typeof s[req.session.user] !== 'object') {
      s[req.session.user] = { retention: typeof s[req.session.user] === 'number' ? s[req.session.user] : 7 };
    }
    s[req.session.user].accentHex = h || null;
  }
  saveSettings(s);
  res.json({ ok: true });
});
// ─── YouTube cookies upload (admin-only) ─────────────────────
const cookiesUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, true),
});
app.get('/api/settings/cookies', auth, (req, res) => {
  const userCookiesPath = getUserCookiesPath(req.session.user);
  const exists = fs.existsSync(userCookiesPath);
  let mtime = null;
  if (exists) { try { mtime = fs.statSync(userCookiesPath).mtime.toISOString(); } catch {} }
  res.json({ exists, mtime });
});
app.post('/api/settings/cookies', auth, (req, res) => {
  cookiesUpload.single('cookies')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Файл не передан' });
    const txt = req.file.buffer.toString('utf8');
    if (!txt.includes('youtube.com') && !txt.includes('# Netscape HTTP Cookie File')) {
      return res.status(400).json({ error: 'Неверный формат. Нужен Netscape cookies.txt от YouTube.' });
    }
    const userCookiesPath = getUserCookiesPath(req.session.user);
    fs.writeFileSync(userCookiesPath, txt, 'utf8');
    res.json({ ok: true });
  });
});
app.delete('/api/settings/cookies', auth, (req, res) => {
  const userCookiesPath = getUserCookiesPath(req.session.user);
  try { if (fs.existsSync(userCookiesPath)) fs.unlinkSync(userCookiesPath); } catch {}
  res.json({ ok: true });
});
// Cookies upload via extension (Bearer auth)
app.options('/api/ext/cookies', (req, res) => res.set(EXT_CORS).sendStatus(204));
app.get('/api/ext/cookies', extCors, authToken, (req, res) => {
  const userCookiesPath = getUserCookiesPath(req.tokenUser);
  const exists = fs.existsSync(userCookiesPath);
  let mtime = null;
  if (exists) { try { mtime = fs.statSync(userCookiesPath).mtime.toISOString(); } catch {} }
  res.set(EXT_CORS).json({ exists, mtime });
});
app.post('/api/ext/cookies', extCors, authToken, (req, res) => {
  cookiesUpload.single('cookies')(req, res, (err) => {
    if (err) return res.status(400).set(EXT_CORS).json({ error: err.message });
    if (!req.file) return res.status(400).set(EXT_CORS).json({ error: 'Файл не передан' });
    const txt = req.file.buffer.toString('utf8');
    if (!txt.includes('youtube.com') && !txt.includes('# Netscape HTTP Cookie File')) {
      return res.status(400).set(EXT_CORS).json({ error: 'Неверный формат. Нужен Netscape cookies.txt.' });
    }
    const userCookiesPath = getUserCookiesPath(req.tokenUser);
    fs.writeFileSync(userCookiesPath, txt, 'utf8');
    res.set(EXT_CORS).json({ ok: true });
  });
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
  const quotaGb = getUserQuotaGb(req.session.user);
  if (quotaGb !== null) {
    const usedBytes = getUserDiskUsedBytes(req.session.user);
    const newSize = req.files.reduce((s, f) => s + f.size, 0);
    if (usedBytes + newSize > quotaGb * 1024 * 1024 * 1024) {
      req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
      return res.status(413).json({ error: `Превышена квота (${quotaGb} ГБ). Освободите место.` });
    }
  }
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
    const rawNames = fs.readdirSync(full);
    // .aria2 — служебные контрольные файлы aria2; файл с парным .aria2 ещё докачивается
    const aria2Controls = new Set(rawNames.filter(n => n.endsWith('.aria2')));
    const entries = rawNames
      .filter(n => !n.startsWith('.') && !n.endsWith('.aria2'))
      .map(name => {
        const p = path.join(full, name);
        const stat = fs.statSync(p);
        const isDir = stat.isDirectory();
        let fileCount = 0;
        if (isDir) { try { fileCount = fs.readdirSync(p).filter(n => !n.startsWith('.')).length; } catch {} }
        const downloading = !isDir && aria2Controls.has(name + '.aria2');
        return { name, isDir, size: isDir ? 0 : stat.size, mtime: stat.mtime, fileCount, downloading };
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
      fs.readdirSync(dir).filter(n => !n.startsWith('.') && !n.endsWith('.aria2')).forEach(name => {
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
  const allActivities = loadActivity();
  if (isAdmin(req.session.user)) {
    res.json(allActivities);
  } else {
    const filtered = allActivities.filter(a => a.username === req.session.user);
    res.json(filtered);
  }
});
// GET /api/fm/search?q=
app.get('/api/fm/search', auth, (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json({ entries: [] });
  const base = userDir(req.session.user);
  const results = [];
  function walk(dir, relDir) {
    try {
      fs.readdirSync(dir).filter(n => !n.startsWith('.') && !n.endsWith('.aria2')).forEach(name => {
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
app.get('/api/fm/read-text', auth, (req, res) => {
  const full = fmResolve(req.session.user, req.query.path || '');
  if (!full || !fs.existsSync(full)) return res.status(404).json({ error: 'Файл не найден' });
  const stat = fs.statSync(full);
  if (stat.isDirectory()) return res.status(400).json({ error: 'Это папка' });
  if (stat.size > 512 * 1024) return res.status(413).json({ error: 'Файл слишком большой для редактирования (> 512 КБ)' });
  try {
    const text = fs.readFileSync(full, 'utf8');
    res.json({ text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/fm/write-text', auth, (req, res) => {
  const full = fmResolve(req.session.user, req.body.path || '');
  if (!full) return res.status(403).json({ error: 'Invalid path' });
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'Файл не найден' });
  if (fs.statSync(full).isDirectory()) return res.status(400).json({ error: 'Это папка' });
  if (typeof req.body.text !== 'string') return res.status(400).json({ error: 'Нет текста' });
  try {
    fs.writeFileSync(full, req.body.text, 'utf8');
    logActivity(req.session.user, 'Редактирование', 'Отредактирован файл: ' + (req.body.path || ''));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  const fmAddUrlQuota = getUserQuotaGb(req.session.user);
  if (fmAddUrlQuota !== null) {
    const usedBytes = getUserDiskUsedBytes(req.session.user);
    if (usedBytes >= fmAddUrlQuota * 1024 * 1024 * 1024) {
      return res.status(413).json({ error: `Превышена квота (${fmAddUrlQuota} ГБ). Освободите место.` });
    }
  }
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
// POST /api/fm/torrent-start  body: { path }  — запустить скачивание .torrent файла через aria2
app.post('/api/fm/torrent-start', auth, async (req, res) => {
  const relPath = (req.body.path || '').trim();
  if (!relPath) return res.status(400).json({ error: 'path required' });
  const full = fmResolve(req.session.user, relPath);
  if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) return res.status(404).json({ error: 'Файл не найден' });
  if (path.extname(full).toLowerCase() !== '.torrent') return res.status(400).json({ error: 'Не .torrent файл' });
  // Квота
  const quota = getUserQuotaGb(req.session.user);
  if (quota !== null) {
    const usedBytes = getUserDiskUsedBytes(req.session.user);
    if (usedBytes >= quota * 1024 * 1024 * 1024) {
      return res.status(413).json({ error: `Превышена квота (${quota} ГБ). Освободите место.` });
    }
  }
  // Папка назначения — рядом с .torrent файлом
  const destRel = path.dirname(relPath) === '.' ? '' : path.dirname(relPath).replace(/\\/g, '/');
  const destDir = fmResolve(req.session.user, destRel);
  if (!destDir) return res.status(403).json({ error: 'Invalid path' });
  try {
    const torrentB64 = fs.readFileSync(full).toString('base64');
    const gid = await aria2('aria2.addTorrent', [torrentB64, [], { dir: destDir }]);
    const torrentName = path.basename(full, '.torrent');
    const jobs = loadMediaJobs();
    jobs[gid] = {
      id: gid,
      user: req.session.user,
      url: 'torrent:' + path.basename(full),
      mode: 'file',
      status: 'active',
      progress: 0,
      speed: '',
      eta: '',
      name: torrentName,
      file: '',
      folder: destRel || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAtMs: Date.now(),
      error: '',
    };
    saveMediaJobs(jobs);
    logActivity(req.session.user, 'Торрент', 'Запущено скачивание торрента: ' + path.basename(full) + (destRel ? ' в ' + destRel : ''));
    sse.emit(req.session.user, 'jobs', { ts: Date.now() });
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
  const quality = ['2160','1440','1080','720','480','360'].includes(req.body.quality) ? req.body.quality : '';
  if (!dlUrl) return res.status(400).json({ error: 'URL empty' });
  if (!isUriSafe(dlUrl)) return res.status(400).json({ error: 'URL заблокирован (приватный/локальный адрес или неподдерживаемая схема)' });
  const dir = fmResolve(req.session.user, relPath);
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return res.status(403).json({ error: 'Invalid path' });
  ytDlpAvailable((available) => {
    if (!available) return res.status(500).json({ error: 'yt-dlp is not installed on server' });
    try {
      const job = startMediaJob({ username: req.session.user, url: dlUrl, dir, relPath, mode, filename, quality });
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
// Найти свободное имя файла в папке (1.png → 1 (2).png → 1 (3).png …)
function resolveFreeName(dir, filename) {
  const ext  = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = filename;
  let i = 2;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = base + ' (' + i + ')' + ext;
    i++;
  }
  return candidate;
}
// POST /api/fm/check-conflicts?path=  body: { filenames: ["a.png","b.mp4"] }
app.post('/api/fm/check-conflicts', auth, (req, res) => {
  const dir = fmResolve(req.session.user, req.query.path || '');
  if (!dir) return res.status(400).json({ error: 'Invalid path' });
  const { filenames } = req.body;
  if (!Array.isArray(filenames)) return res.status(400).json({ error: 'filenames required' });
  const conflicts = filenames
    .map(name => {
      if (typeof name !== 'string') return null;
      const safe = path.basename(name).replace(/[/\\]/g, '_');
      if (!safe || !fs.existsSync(path.join(dir, safe))) return null;
      return { name: safe, freeName: resolveFreeName(dir, safe) };
    })
    .filter(Boolean);
  res.json({ conflicts });
});
// POST /api/fm/upload?path=&conflictMode=replace|skip|rename
const fmUploader = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const fp = fmResolve(req.session.user, req.query.path || '');
      if (!fp) return cb(new Error('Invalid path'));
      if (!fs.existsSync(fp)) fs.mkdirSync(fp, { recursive: true });
      cb(null, fp);
    },
    filename: (req, file, cb) => {
      const origName = path.basename(Buffer.from(file.originalname, 'latin1').toString('utf8')).replace(/[/\\]/g, '_');
      const mode = req.query.conflictMode || 'replace';
      if (mode === 'rename') {
        const dir = fmResolve(req.session.user, req.query.path || '');
        return cb(null, dir ? resolveFreeName(dir, origName) : origName);
      }
      cb(null, origName);
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // Делегируем базовую проверку расширения в общий фильтр
    multerFileFilter(req, file, (err, ok) => {
      if (err) return cb(err);
      if (ok === false) return cb(null, false);
      // Режим skip — не принимать файлы, которые уже существуют
      if (req.query.conflictMode === 'skip') {
        const dir = fmResolve(req.session.user, req.query.path || '');
        const origName = path.basename(Buffer.from(file.originalname, 'latin1').toString('utf8')).replace(/[/\\]/g, '_');
        if (dir && fs.existsSync(path.join(dir, origName))) return cb(null, false);
      }
      cb(null, true);
    });
  },
});
app.post('/api/fm/upload', auth, (req, res) => {
  fmUploader.array('files', 50)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.files) return res.status(400).json({ error: 'Нет файлов' });
    // conflictMode=skip может оставить req.files пустым — это не ошибка
    if (!req.files.length) return res.json({ ok: true, files: [], skipped: true });
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