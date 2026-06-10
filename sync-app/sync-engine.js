/**
 * VPS Sync Engine
 * Использует HTTP-API сервера (те же эндпоинты что и веб-интерфейс).
 * Аутентификация через POST /login → session cookie.
 */
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const fetch   = require('node-fetch');
const chokidar = require('chokidar');
const { FormData, Blob } = require('node-fetch');

class SyncEngine {
  constructor({ serverUrl, username, password, onLog, onStatus }) {
    this.serverUrl = serverUrl.replace(/\/$/, '');
    this.username  = username;
    this.password  = password;
    this.onLog     = onLog  || (() => {});
    this.onStatus  = onStatus || (() => {});
    this.cookie    = null;
    this.watchers  = new Map(); // pairId → chokidar watcher
    this.debounces = new Map(); // pairId → timer
  }

  // ── Auth ─────────────────────────────────────────────────────────────────
  async login() {
    const res = await fetch(`${this.serverUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `username=${encodeURIComponent(this.username)}&password=${encodeURIComponent(this.password)}`,
      redirect: 'manual',
    });
    const setCookie = res.headers.get('set-cookie');
    if (!setCookie) throw new Error('Неверные логин/пароль');
    this.cookie = setCookie.split(';')[0];
    this.onLog('info', '✓ Подключено к серверу');
    return true;
  }

  async ensureAuth() {
    if (!this.cookie) await this.login();
    // Verify session still valid
    const r = await this._fetch('/api/me');
    if (!r.ok) {
      this.cookie = null;
      await this.login();
    }
  }

  _fetch(path, opts = {}) {
    return fetch(`${this.serverUrl}${path}`, {
      ...opts,
      headers: { ...(opts.headers || {}), Cookie: this.cookie || '' },
    });
  }

  // ── Remote file listing ──────────────────────────────────────────────────
  async listRemote(remotePath) {
    await this.ensureAuth();
    const r = await this._fetch(`/api/fm/list?path=${encodeURIComponent(remotePath)}`);
    if (!r.ok) throw new Error(`listRemote ${remotePath}: HTTP ${r.status}`);
    const data = await r.json();
    return (data.items || []);
  }

  async listRemoteRecursive(remotePath) {
    const items = await this.listRemote(remotePath);
    const files = [];
    for (const item of items) {
      if (item.isDir) {
        const sub = await this.listRemoteRecursive(item.path || `${remotePath}/${item.name}`);
        files.push(...sub);
      } else {
        files.push(item);
      }
    }
    return files;
  }

  // ── Local file listing ───────────────────────────────────────────────────
  listLocal(localDir) {
    const results = [];
    const walk = (dir, rel = '') => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        const relPath = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          walk(full, relPath);
        } else {
          try {
            const stat = fs.statSync(full);
            results.push({ name: ent.name, relPath, fullPath: full, size: stat.size, mtime: stat.mtimeMs });
          } catch {}
        }
      }
    };
    walk(localDir);
    return results;
  }

  // ── Upload one file ───────────────────────────────────────────────────────
  async uploadFile(localFullPath, remoteDir, conflictMode = 'replace') {
    await this.ensureAuth();
    const filename = path.basename(localFullPath);
    const fileBuffer = fs.readFileSync(localFullPath);
    const blob = new Blob([fileBuffer]);

    const fd = new FormData();
    fd.append('files', blob, filename);

    const url = `${this.serverUrl}/api/fm/upload?path=${encodeURIComponent(remoteDir)}&conflictMode=${conflictMode}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { Cookie: this.cookie || '' },
      body: fd,
    });
    if (!r.ok) {
      const err = await r.text().catch(() => '');
      throw new Error(`Upload ${filename}: HTTP ${r.status} ${err}`);
    }
    return await r.json();
  }

  // ── Download one file ─────────────────────────────────────────────────────
  async downloadFile(remotePath, localFullPath) {
    await this.ensureAuth();
    const r = await this._fetch(`/api/fm/download?path=${encodeURIComponent(remotePath)}`);
    if (!r.ok) throw new Error(`Download ${remotePath}: HTTP ${r.status}`);
    const dir = path.dirname(localFullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const buf = await r.buffer();
    fs.writeFileSync(localFullPath, buf);
  }

  // ── Full sync of one pair ─────────────────────────────────────────────────
  async syncPair(pair, progressCb) {
    const { localPath, remotePath, direction, conflictMode = 'replace' } = pair;
    const emit = (msg, pct) => {
      this.onLog('info', msg);
      if (progressCb) progressCb(msg, pct);
    };

    emit('Сканирую локальные файлы...', 5);
    const localFiles = this.listLocal(localPath);

    let remoteFiles = [];
    try {
      emit('Сканирую удалённые файлы...', 15);
      remoteFiles = await this.listRemoteRecursive(remotePath);
    } catch (e) {
      this.onLog('warn', 'Не удалось получить список файлов на сервере: ' + e.message);
    }

    const remoteMap = new Map(remoteFiles.map(f => [f.name, f]));
    const localMap  = new Map(localFiles.map(f => [f.relPath, f]));

    let done = 0, total = 0;

    // Upload (local → remote)
    if (direction === 'upload' || direction === 'both') {
      const toUpload = localFiles.filter(f => {
        const remote = remoteMap.get(f.name);
        if (!remote) return true; // new file
        if (conflictMode === 'skip') return false; // skip existing
        return f.size !== remote.size; // upload if size differs
      });
      total += toUpload.length;
      emit(`Загружаю ${toUpload.length} файл(ов)...`, 20);
      for (const f of toUpload) {
        try {
          await this.uploadFile(f.fullPath, remotePath, conflictMode);
          done++;
          emit(`↑ ${f.name}`, Math.round(20 + (done / total) * 60));
        } catch (e) {
          this.onLog('error', `Ошибка загрузки ${f.name}: ${e.message}`);
        }
      }
    }

    // Download (remote → local)
    if (direction === 'download' || direction === 'both') {
      const toDownload = remoteFiles.filter(f => {
        const local = localMap.get(f.name);
        if (!local) return true; // new file
        if (conflictMode === 'skip') return false;
        return f.size !== local.size;
      });
      total += toDownload.length;
      emit(`Скачиваю ${toDownload.length} файл(ов)...`, 80);
      for (const f of toDownload) {
        const localDest = path.join(localPath, f.name);
        try {
          await this.downloadFile(f.path || `${remotePath}/${f.name}`, localDest);
          done++;
          emit(`↓ ${f.name}`, Math.round(80 + (done / total) * 15));
        } catch (e) {
          this.onLog('error', `Ошибка скачивания ${f.name}: ${e.message}`);
        }
      }
    }

    emit('Синхронизация завершена', 100);
    return { uploaded: direction !== 'download' ? done : 0, downloaded: direction !== 'upload' ? done : 0 };
  }

  // ── Watch mode ────────────────────────────────────────────────────────────
  startWatch(pairId, pair) {
    if (this.watchers.has(pairId)) return;
    const { localPath, remotePath, conflictMode = 'replace' } = pair;

    const watcher = chokidar.watch(localPath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 200 },
      ignored: /(^|[/\\])\../, // hidden files
    });

    const trigger = (event, filePath) => {
      // Debounce: wait 2s after last change in pair
      if (this.debounces.has(pairId)) clearTimeout(this.debounces.get(pairId));
      this.debounces.set(pairId, setTimeout(async () => {
        this.debounces.delete(pairId);
        if (event === 'unlink') return; // skip deletions for now
        const relName = path.basename(filePath);
        this.onLog('info', `Изменён: ${relName} — синхронизирую...`);
        this.onStatus(pairId, 'syncing');
        try {
          await this.uploadFile(filePath, remotePath, conflictMode);
          this.onLog('info', `✓ ${relName} загружен`);
          this.onStatus(pairId, 'idle');
        } catch (e) {
          this.onLog('error', `✗ ${relName}: ${e.message}`);
          this.onStatus(pairId, 'error');
        }
      }, 2000));
    };

    watcher.on('add',    f => trigger('add', f));
    watcher.on('change', f => trigger('change', f));

    this.watchers.set(pairId, watcher);
    this.onLog('info', `👁 Слежу за ${localPath}`);
  }

  stopWatch(pairId) {
    const w = this.watchers.get(pairId);
    if (w) { w.close(); this.watchers.delete(pairId); }
    const t = this.debounces.get(pairId);
    if (t) { clearTimeout(t); this.debounces.delete(pairId); }
  }

  stopAll() {
    for (const id of this.watchers.keys()) this.stopWatch(id);
  }
}

module.exports = SyncEngine;
