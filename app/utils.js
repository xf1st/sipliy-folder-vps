const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { execFile } = require('child_process');
const config = require('./config');
const db = require('./db');

function htmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtBytes(b) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = b;
  while (v >= 1024 && i < 4) { v /= 1024; i++; }
  return v.toFixed(1) + ' ' + units[i];
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
    e.lockUntil = Date.now() + Math.min(30000 * Math.pow(2, e.fails - 5), 1800000);
  }
  _loginFails.set(ip, e);
}

function loginOk(ip) { _loginFails.delete(ip); }

// Cleanup interval
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of _loginFails) {
    if (e.lockUntil && e.lockUntil < now - 3600000) _loginFails.delete(ip);
  }
}, 600000).unref?.();

function multerFileFilter(req, file, cb) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (config.FORBIDDEN_UPLOAD_EXT.has(ext)) {
    return cb(new Error('Расширение ' + ext + ' запрещено'));
  }
  cb(null, true);
}

function auth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.redirect('/login');
}

function authToken(req, res, next) {
  const h = req.headers['authorization'] || '';
  const token = h.replace(/^Bearer\s+/, '').trim();
  if (!token) return res.status(401).json({ error: 'No token' });
  const tokens = db.loadTokens();
  const username = tokens[token];
  if (!username) return res.status(401).json({ error: 'Invalid token' });
  req.tokenUser = username;
  next();
}

function userDir(username) {
  const dir = path.join(config.DOWNLOADS_ROOT, username);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  return dir;
}

async function aria2(method, params = []) {
  const payload = { jsonrpc: '2.0', id: crypto.randomUUID(), method, params: [`token:${config.ARIA2_TOKEN}`, ...params] };
  const res = await axios.post(config.ARIA2_URL, payload, { timeout: 8000 });
  if (res.data.error) throw new Error(res.data.error.message || 'aria2 error');
  return res.data.result;
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

function buildMediaFormat(mode, quality) {
  if (mode === 'audio') return null;
  const validH = { '2160': 2160, '1440': 1440, '1080': 1080, '720': 720, '480': 480, '360': 360 };
  const maxH = validH[quality] || null;
  if (mode === 'best') {
    if (maxH) return `bestvideo[height<=${maxH}]+bestaudio/best[height<=${maxH}]`;
    return 'bestvideo+bestaudio/best';
  }
  const h = maxH || 1080;
  return `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`;
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

function fmResolve(username, relPath) {
  if (!username) return null;
  const base = userDir(username);
  const rel = (relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const full = path.resolve(path.join(base, rel));
  const inside = path.relative(base, full);
  if (inside && (inside.startsWith('..') || path.isAbsolute(inside))) return null;
  return full;
}

function fmRelative(username, fullPath) {
  return path.relative(userDir(username), fullPath).replace(/\\/g, '/');
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

module.exports = {
  htmlEscape,
  fmtBytes,
  isUriSafe,
  loginGate,
  loginFail,
  loginOk,
  multerFileFilter,
  auth,
  authToken,
  userDir,
  aria2,
  newestMediaFile,
  mediaExtOk,
  stripKnownMediaExt,
  ensureMediaExtension,
  validateMediaFile,
  buildMediaFormat,
  filenameWithUrlExtension,
  fmResolve,
  fmRelative,
  shareOwner,
  shareCreated,
  sharePathMatches,
  shareFilePath,
  fmDirSize,
  fmArchiveDir,
  fmCollectItems,
};
