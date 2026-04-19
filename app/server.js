const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const FormData = require('form-data');
const { exec } = require('child_process');
const multer = require('multer');

const VT_API_KEY = '93c0c934a298f0f35b0f95be051de5b4e4ea7340fa3c7bb8fd5c1f572a13c2b8';
const SHARES_FILE = '/opt/vps-downloader/shares.json';

function loadShares() {
  try { return JSON.parse(fs.readFileSync(SHARES_FILE, 'utf8')); }
  catch { return {}; }
}
function saveShares(s) {
  fs.writeFileSync(SHARES_FILE, JSON.stringify(s));
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
const ARIA2_URL = 'http://localhost:6800/jsonrpc';
const ARIA2_TOKEN = 'mySecretToken123';
const DOWNLOADS_ROOT = '/var/downloads';

const USERS = {
  admin:  { password: 'admin123',  label: 'Admin' },
  friend: { password: 'friend123', label: 'Friend' },
};

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('/opt/vps-downloader/public', { maxAge: '7d' }));
app.use(session({
  store: new FileStore({ path: '/opt/vps-downloader/sessions', ttl: 30 * 24 * 60 * 60 }),
  secret: 'vps-dl-secret-key-2024',
  resave: true,
  saveUninitialized: false,
  rolling: true,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true }, // 30 дней, обновляется при каждом запросе
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

// ─── Routes ─────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.send(loginPage());
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = USERS[username];
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

app.get('/', auth, (req, res) => res.send(mainPage(req.session.user)));

function fmtBytes(b) {
  const units = ['B','KB','MB','GB','TB'];
  let i = 0, v = b;
  while (v >= 1024 && i < 4) { v /= 1024; i++; }
  return v.toFixed(1) + ' ' + units[i];
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
  const dir = userDir(req.session.user);
  try {
    const [active, waiting, stopped] = await Promise.all([
      aria2('aria2.tellActive'),
      aria2('aria2.tellWaiting', [0, 999]),
      aria2('aria2.tellStopped', [0, 50]),
    ]);
    const mine = [...active, ...waiting, ...stopped]
      .filter(d => d.dir && d.dir.startsWith(dir))
      .map(d => ({
        gid: d.gid,
        status: d.status,
        name: d.files?.[0]?.path ? path.basename(d.files[0].path) : (d.bittorrent?.info?.name || '...'),
        size: parseInt(d.totalLength || 0),
        downloaded: parseInt(d.completedLength || 0),
        speed: parseInt(d.downloadSpeed || 0),
        progress: d.totalLength > 0 ? Math.round(d.completedLength / d.totalLength * 100) : 0,
      }));
    res.json(mine);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/add', auth, async (req, res) => {
  const dlUrl = (req.body.url || '').trim();
  const outName = (req.body.filename || '').trim().replace(/[/\\:*?"<>|]/g, '_');
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
  shares[token] = { file: filename, user: req.session.user, created: new Date().toISOString() };
  saveShares(shares);
  res.json({ token });
});

app.delete('/api/share/:token', auth, (req, res) => {
  const shares = loadShares();
  const s = shares[req.params.token];
  if (s && s.user === req.session.user) {
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
  const file = path.join(userDir(s.user), path.basename(s.file));
  if (!fs.existsSync(file)) return res.status(404).send(shareNotFoundPage());
  res.download(file);
});

app.get('/api/shares', auth, (req, res) => {
  const shares = loadShares();
  const mine = Object.entries(shares)
    .filter(([, s]) => s.user === req.session.user)
    .map(([token, s]) => ({ token, file: s.file, created: s.created }));
  res.json(mine);
});

// CORS helper for extension endpoints
const EXT_CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
function extCors(req, res, next) { res.set(EXT_CORS); next(); }

app.options('/api/add-ext',       (req, res) => res.set(EXT_CORS).sendStatus(204));
app.options('/api/downloads-ext', (req, res) => res.set(EXT_CORS).sendStatus(204));
app.options('/api/files-ext',     (req, res) => res.set(EXT_CORS).sendStatus(204));

app.post('/api/add-ext', extCors, authToken, async (req, res) => {
  const dlUrl = (req.body.url || '').trim();
  if (!dlUrl) return res.status(400).json({ error: 'URL пустой' });
  const dir = userDir(req.tokenUser);
  try {
    const gid = await aria2('aria2.addUri', [[dlUrl], { dir }]);
    res.json({ ok: true, gid });
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
        name: d.files?.[0]?.path ? path.basename(d.files[0].path) : (d.bittorrent?.info?.name || '...'),
        size: parseInt(d.totalLength || 0),
        downloaded: parseInt(d.completedLength || 0),
        speed: parseInt(d.downloadSpeed || 0),
        progress: d.totalLength > 0 ? Math.round(d.completedLength / d.totalLength * 100) : 0,
      }));
    res.json(mine);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Список файлов для расширения (Bearer-auth)
app.get('/api/files-ext', extCors, authToken, (req, res) => {
  const dir = userDir(req.tokenUser);
  try {
    const files = fs.readdirSync(dir)
      .map(name => { const s = fs.statSync(path.join(dir, name)); return { name, size: s.size, mtime: s.mtime }; })
      .sort((a, b) => new Date(b.mtime) - new Date(a.mtime))
      .slice(0, 30);
    res.json(files);
  } catch { res.json([]); }
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

app.post('/api/mytoken/reset', auth, (req, res) => {
  const tokens = loadTokens();
  Object.keys(tokens).forEach(t => { if (tokens[t] === req.session.user) delete tokens[t]; });
  const token = crypto.randomUUID();
  tokens[token] = req.session.user;
  saveTokens(tokens);
  res.json({ token });
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

// ─── Upload ──────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, userDir(req.session.user)),
  filename: (req, file, cb) => {
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, name);
  },
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

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

function runCleanup() {
  Object.keys(USERS).forEach(function(username) {
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
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet"/>
<script>
tailwind.config={darkMode:'class',theme:{extend:{colors:{"background":"rgb(var(--c-bg)/<alpha-value>)","surface":"rgb(var(--c-bg)/<alpha-value>)","surface-container-lowest":"rgb(var(--c-s0)/<alpha-value>)","surface-container-low":"rgb(var(--c-s1)/<alpha-value>)","surface-container":"rgb(var(--c-s2)/<alpha-value>)","surface-container-high":"rgb(var(--c-s3)/<alpha-value>)","surface-container-highest":"rgb(var(--c-s4)/<alpha-value>)","surface-variant":"rgb(var(--c-sv)/<alpha-value>)","primary":"rgb(var(--c-p)/<alpha-value>)","primary-container":"rgb(var(--c-pc)/<alpha-value>)","on-primary":"rgb(var(--c-op)/<alpha-value>)","on-primary-container":"rgb(var(--c-opc)/<alpha-value>)","primary-fixed-dim":"rgb(var(--c-pfd)/<alpha-value>)","secondary":"rgb(var(--c-sec)/<alpha-value>)","secondary-container":"rgb(var(--c-secc)/<alpha-value>)","on-secondary-container":"rgb(var(--c-osec)/<alpha-value>)","outline":"rgb(var(--c-out)/<alpha-value>)","outline-variant":"rgb(var(--c-outv)/<alpha-value>)","on-surface":"rgb(var(--c-os)/<alpha-value>)","on-surface-variant":"rgb(var(--c-osv)/<alpha-value>)","error":"rgb(var(--c-err)/<alpha-value>)","tertiary":"rgb(var(--c-ter)/<alpha-value>)"},fontFamily:{headline:["Plus Jakarta Sans"],body:["Manrope"],label:["Manrope"]},borderRadius:{"xl":"0.75rem","2xl":"1rem","3xl":"1.5rem","4xl":"2rem","full":"9999px"}}}}
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
  const label = USERS[username] ? USERS[username].label : username;
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
    '<div class="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden">' +
      '<div class="flex items-center justify-between px-6 pt-5 pb-4 border-b border-gray-100">' +
        '<div class="flex items-center gap-3">' +
          '<span class="material-symbols-outlined" style="color:#6b509a">settings</span>' +
          '<p style="font-family:Plus Jakarta Sans,sans-serif;font-weight:700;font-size:0.95rem;color:#1a1c1f">Настройки</p>' +
        '</div>' +
        '<button onclick="document.getElementById(\'settings-modal\').classList.add(\'hidden\')" class="p-2 hover:bg-gray-100 rounded-full text-gray-400 hover:text-gray-600 transition-colors">' +
          '<span class="material-symbols-outlined">close</span>' +
        '</button>' +
      '</div>' +
      '<div class="p-6 space-y-5">' +
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
