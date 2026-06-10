const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const axios = require('axios');
const config = require('./config');
const db = require('./db');
const utils = require('./utils');
const sse = require('./sse');

const mediaProcesses = new Map();

function loadMediaJobs() {
  try { return JSON.parse(fs.readFileSync(config.MEDIA_JOBS_FILE, 'utf8')); }
  catch { return {}; }
}

function saveMediaJobs(jobs) {
  db.writeJsonAtomic(config.MEDIA_JOBS_FILE, jobs, { pretty: true });
}

function mediaJobPublic(job) {
  const rawError = job.error || '';
  const isWarningOnly = /^WARNING:/i.test(rawError) && ['active', 'processing', 'complete'].includes(job.status);
  return {
    id: job.id,
    url: job.url,
    mode: job.mode,
    quality: job.quality || '',
    status: job.status,
    progress: job.progress || 0,
    speed: job.speed || '',
    eta: job.eta || '',
    streamLabel: job.streamLabel || '',
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
  const dir = utils.userDir(username);
  const jobs = loadMediaJobs();
  let changed = false;
  let all = [];
  try {
    const [active, waiting, stopped] = await Promise.all([
      utils.aria2('aria2.tellActive'),
      utils.aria2('aria2.tellWaiting', [0, 1000]),
      utils.aria2('aria2.tellStopped', [0, 1000]),
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
    else if (d.status === 'active' || d.status === 'waiting' || d.status === 'paused') { j.status = d.status; j.progress = progress; j.speed = utils.fmtBytes(parseInt(d.downloadSpeed || 0)) + '/s'; }
    j.updatedAt = new Date().toISOString();
    jobs[d.gid] = j;
    changed = true;
  });
  Object.values(jobs).forEach(j => {
    if (!j || j.user !== username || seen.has(j.id) || ['complete', 'error', 'cancelled'].includes(j.status)) return;
    if (mediaProcesses.has(j.id)) return;
    const folder = utils.fmResolve(username, j.folder || '');
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
  if (changed) {
    saveMediaJobs(jobs);
    // Уведомляем SSE-клиентов о изменениях
    sse.emit(username, 'jobs', { ts: Date.now() });
  }
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
  const mergeDest = clean.match(/Merging formats into\s+"(.+)"$/i);
  if (mergeDest && mergeDest[1]) {
    job.file = path.basename(mergeDest[1].replace(/^"|"$/g, ''));
    job.name = job.file;
    changed = true;
  }
  if (/\[youtube\].*Downloading webpage/i.test(clean))                  { job.streamLabel = 'Получение страницы...';       changed = true; }
  if (/\[youtube\].*Downloading.*player API/i.test(clean))              { job.streamLabel = 'Загрузка плеера YouTube...';  changed = true; }
  if (/\[jsc:(node|deno|bun)\]|Solving JS challenge/i.test(clean))      { job.streamLabel = 'Решение JS-задачи...';        changed = true; }
  if (/\[youtube\].*Downloading m3u8/i.test(clean))                     { job.streamLabel = 'Получение плейлиста...';      changed = true; }
  if (/\[info\].*Downloading \d+ format/i.test(clean))                  { job.streamLabel = 'Начинаю скачивание...';       changed = true; }
  const fmtLine = clean.match(/Downloading \d+ format\(s\):\s*(.+)$/i);
  if (fmtLine && fmtLine[1].trim().includes('+')) { job._twoStream = true; changed = true; }
  const dest = clean.match(/\[download\]\s+Destination:\s+(.+)$/i);
  if (dest && dest[1]) {
    job._destCount = (job._destCount || 0) + 1;
    job.file = path.basename(dest[1]);
    job.name = job.file;
    if (job._destCount === 1) job.streamLabel = 'Загрузка видео';
    if (job._destCount === 2) { job.streamLabel = 'Загрузка аудио'; job.progress = 50; }
    changed = true;
  }
  const pct = clean.match(/\[download\]\s+([0-9.]+)%/);
  if (pct) {
    const raw = Math.max(0, Math.min(100, parseFloat(pct[1])));
    const dc = job._destCount || 1;
    let scaled;
    if (dc >= 2) {
      scaled = 50 + raw / 2;
    } else if (job._twoStream) {
      scaled = raw / 2;
    } else {
      scaled = raw;
    }
    job.progress = Math.round(scaled * 10) / 10;
    changed = true;
  }
  const speed = clean.match(/\bat\s+([^\s]+\/s)/);
  if (speed) { job.speed = speed[1]; changed = true; }
  const eta = clean.match(/\bETA\s+([^\s]+)/);
  if (eta) { job.eta = eta[1]; changed = true; }
  if (clean.includes('[Merger]') || clean.includes('[ffmpeg]')) {
    job.status = 'processing'; job.streamLabel = 'Слияние файлов'; job.speed = ''; job.eta = ''; changed = true;
  }
  if (clean.includes('[ExtractAudio]')) {
    job.status = 'processing'; job.streamLabel = 'Конвертация в MP3'; job.speed = ''; changed = true;
  }
  return changed;
}

function startMediaJob({ username, url, dir, relPath, mode, filename, quality }) {
  const jobs = loadMediaJobs();
  const id = crypto.randomUUID();
  const safeBase = utils.stripKnownMediaExt(filename);
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
    '--concurrent-fragments', '4',
    '--hls-use-mpegts',
    '--fixup', 'detect_or_warn',
    '-o', output,
  ];
  if (mode === 'audio') {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  } else {
    const fmt = utils.buildMediaFormat(mode, quality);
    const mergeExt = (mode === 'best' && !quality) ? 'mkv' : 'mp4';
    args.push('-f', fmt, '--merge-output-format', mergeExt);
  }
  const userCookiesPath = config.getUserCookiesPath(username);
  if (fs.existsSync(userCookiesPath)) {
    args.push('--cookies', userCookiesPath);
  } else if (fs.existsSync(config.YTDLP_COOKIES_FILE)) {
    args.push('--cookies', config.YTDLP_COOKIES_FILE);
  }
  args.push('--js-runtimes', 'node');
  args.push('--force-ipv6');
  args.push('--socket-timeout', '30');
  args.push(url);
  const job = {
    id,
    user: username,
    url,
    mode,
    quality: quality || '',
    status: 'starting',
    progress: 0,
    speed: '',
    eta: '',
    streamLabel: '',
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
  const child = spawn('yt-dlp', args, { cwd: dir, env: { ...process.env, PYTHONUNBUFFERED: '1' } });
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
    j.status = j.status === 'starting' ? 'active' : j.status;
    const allLines = String(chunk).split(/\r?\n/);
    allLines.forEach(line => parseYtDlpLine(j, line));
    const IGNORE_PATTERNS = ['SABR', 'android client', 'missing a URL', 'player_client', 'JS runtime', 'javascript runtime', 'skipped as they are', 'streaming experiment', 'github.com/yt-dlp', '[download]', '[info]', '[youtube]', '[ffmpeg]', '[Merger]', '[ExtractAudio]', '[VideoConvertor]'];
    const displayLines = allLines.filter(l => {
      const lt = l.trim();
      return lt && !IGNORE_PATTERNS.some(p => lt.toLowerCase().includes(p.toLowerCase()));
    });
    const realErrors = displayLines.filter(line => /^ERROR:/i.test(line));
    if (realErrors.length) j.error = realErrors.slice(-2).join(' ');
    else {
      const warnLines = displayLines.filter(line => /^WARNING:/i.test(line));
      if (warnLines.length) j.warning = warnLines.slice(-1).join(' ');
    }
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
            const newest = utils.newestMediaFile(dir, j.startedAtMs || Date.now());
            if (newest) {
              full = newest.full;
              j.file = newest.name;
              j.name = newest.name;
            }
          }
          full = utils.ensureMediaExtension(j.mode, full);
          if (full && fs.existsSync(full)) {
            j.file = path.basename(full);
            j.name = j.file;
          }
          utils.validateMediaFile(j.mode, full, validationErr => {
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
            // SSE: уведомить клиента + Web Push при завершении
            sse.emit(doneJob.user, 'jobs', { ts: Date.now(), done: doneJob.id });
            // sendPushToUser вызывается из server.js через хук (чтобы не создавать circular dep)
            if (typeof global._pushJobDone === 'function') global._pushJobDone(doneJob);
          });
        } else if (!j.error) {
          j.status = 'error';
          j.error = 'yt-dlp exited with code ' + code;
        }
      }
      j.updatedAt = new Date().toISOString();
      current[id] = j;
      saveMediaJobs(current);
      if (j.status === 'error') sse.emit(j.user, 'jobs', { ts: Date.now(), error: j.id });
    }
    mediaProcesses.delete(id);
  });
  return job;
}

module.exports = {
  mediaProcesses,
  loadMediaJobs,
  saveMediaJobs,
  mediaJobPublic,
  syncAriaDownloadJobs,
  ytDlpAvailable,
  startMediaJob,
};
