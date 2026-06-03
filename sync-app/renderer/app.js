/* ─────────────────────────────────────────────────────────────────────────
   VPS Sync Manager — renderer app.js
   ───────────────────────────────────────────────────────────────────────── */

// ── State ─────────────────────────────────────────────────────────────────
let config = {
  serverUrl: 'http://77.73.135.98:3000',
  username: '',
  password: '',
  syncPairs: [],
  conflictMode: 'ask',
  maxSizeMb: 500,
  maxSizeUnit: 'mb',
  excludeExt: '',
  minimizeToTray: true,
  startWithWindows: false,
};

let activityLog = [];
let sessionSynced = 0;

// ── Init ──────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  config = await window.api.loadConfig();
  applyConfigToUI();
  navigateTo('sync-folders');
  updateClock();
  setInterval(updateClock, 30000);
  checkConnection();
  setInterval(checkConnection, 15000);
  renderSyncPairs();
  updateDashboard();

  // Tray trigger
  window.api.onTraySync(() => syncAll());
});

// ── Navigation ────────────────────────────────────────────────────────────
function navigateTo(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(a => a.classList.remove('active'));

  const page = document.getElementById('page-' + pageId);
  if (page) page.classList.add('active');

  const navItem = document.querySelector('[data-page="' + pageId + '"]');
  if (navItem) navItem.classList.add('active');
}

document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => navigateTo(item.dataset.page));
});

// ── Clock ─────────────────────────────────────────────────────────────────
function updateClock() {
  const now = new Date();
  const s = now.toLocaleString('ru', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const el = document.getElementById('status-time');
  if (el) el.textContent = s;
}

// ── Connection check ──────────────────────────────────────────────────────
async function checkConnection() {
  const urlEl = document.getElementById('server-url-label');
  if (urlEl) urlEl.textContent = (config.serverUrl || '—').replace(/^https?:\/\//, '');

  try {
    // Любой HTTP-ответ = сервер живой (404 тоже ок — значит работает)
    await fetch(config.serverUrl + '/login', {
      signal: AbortSignal.timeout(4000),
      credentials: 'include',
    });
    setConnStatus('connected');
  } catch {
    setConnStatus('offline');
  }
}

function setConnStatus(state) {
  const dot   = document.getElementById('conn-dot');
  const label = document.getElementById('conn-label');
  if (!dot || !label) return;
  const map = {
    connected: { color: 'bg-tertiary shadow-[0_0_8px_rgba(78,222,163,0.5)]', text: 'Connected',    textColor: 'text-tertiary' },
    offline:   { color: 'bg-error',                                           text: 'Offline',      textColor: 'text-error' },
    error:     { color: 'bg-yellow-400',                                      text: 'Unreachable',  textColor: 'text-yellow-400' },
  };
  const s = map[state] || map.offline;
  dot.className   = 'w-2 h-2 rounded-full ' + s.color;
  label.className = 'font-label-md text-label-md ' + s.textColor;
  label.textContent = s.text;
}

// ── Sync Pairs rendering ──────────────────────────────────────────────────
function renderSyncPairs() {
  const list  = document.getElementById('sync-pairs-list');
  const empty = document.getElementById('sync-empty');
  const pairs = config.syncPairs || [];

  if (!list) return;

  // Удаляем старые карточки (оставляем #sync-empty)
  list.querySelectorAll('.sync-card').forEach(c => c.remove());

  if (pairs.length === 0) {
    if (empty) empty.style.display = 'flex';
    return;
  }
  if (empty) empty.style.display = 'none';

  pairs.forEach((pair, idx) => {
    const card = buildSyncCard(pair, idx);
    list.appendChild(card);
  });

  document.getElementById('dash-pairs').textContent = pairs.length;
  document.getElementById('stat-tasks').textContent = pairs.filter(p => p.status === 'syncing').length;
}

function buildSyncCard(pair, idx) {
  const statusMap = {
    idle:    { badge: 'bg-tertiary/15 text-tertiary',    dot: 'bg-tertiary',   dotAnim: '',                  label: 'Synced',     icon: 'sync', iconColor: 'text-on-surface-variant' },
    syncing: { badge: 'bg-secondary-container/15 text-secondary', dot: 'bg-secondary', dotAnim: 'animate-pulse', label: 'Syncing...', icon: 'pause', iconColor: 'text-error' },
    paused:  { badge: 'bg-surface-bright text-on-surface-variant', dot: 'bg-outline',  dotAnim: '',              label: 'Paused',     icon: 'play_arrow', iconColor: 'text-tertiary' },
    error:   { badge: 'bg-error/15 text-error',          dot: 'bg-error',      dotAnim: '',                  label: 'Error',      icon: 'sync', iconColor: 'text-on-surface-variant' },
  };
  const st = statusMap[pair.status || 'idle'];
  const dirIcon = pair.direction === 'both' ? 'sync_alt' : pair.direction === 'download' ? 'arrow_back' : 'arrow_forward';
  const folderIcon = pair.direction === 'download' ? 'cloud_download' : 'cloud_upload';
  const name = pair.name || pair.localPath.split(/[\\/]/).pop() || 'Folder';

  const card = document.createElement('div');
  card.className = 'sync-card mica-effect rounded-xl p-lg border border-white/5 hover:border-primary/20 transition-all duration-300'
    + (pair.status === 'syncing' ? ' border-l-4 border-l-secondary-container' : '');

  card.innerHTML = `
    <div class="flex justify-between items-start mb-lg">
      <div class="flex gap-md">
        <div class="w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center text-primary">
          <span class="material-symbols-outlined text-2xl" style="font-variation-settings:'FILL' 1">${folderIcon}</span>
        </div>
        <div>
          <h3 class="font-headline-sm text-headline-sm">${H(name)}</h3>
          <p class="text-on-surface-variant font-label-md text-label-md mt-1">${H(pair.localPath)}</p>
        </div>
      </div>
      <span class="${st.badge} px-md py-xs rounded-full flex items-center gap-sm font-label-md text-label-md">
        <span class="w-2 h-2 rounded-full ${st.dot} ${st.dotAnim}"></span>${st.label}
      </span>
    </div>
    <div class="flex items-center gap-lg py-md border-y border-white/5 mb-lg">
      <span class="material-symbols-outlined text-on-surface-variant">${dirIcon}</span>
      <div class="flex-1">
        <div class="flex items-center gap-sm text-on-surface-variant font-label-md">
          <span class="material-symbols-outlined text-sm">storage</span>
          <span class="truncate">${H(pair.remotePath)}</span>
        </div>
      </div>
    </div>
    <div class="flex justify-between items-center">
      <span class="text-on-surface-variant font-label-md text-label-md">${pair.lastSync ? 'Last sync: ' + fmtAgo(pair.lastSync) : 'Ещё не синхронизировалась'}</span>
      <div class="flex gap-sm">
        <button onclick="toggleSync(${idx})" class="p-sm ${st.iconColor} hover:text-primary transition-colors" title="${pair.status === 'syncing' ? 'Пауза' : 'Синхронизировать'}">
          <span class="material-symbols-outlined">${st.icon}</span>
        </button>
        <button onclick="showPairMenu(event,${idx})" class="p-sm text-on-surface-variant hover:text-primary transition-colors">
          <span class="material-symbols-outlined">more_vert</span>
        </button>
      </div>
    </div>
  `;
  return card;
}

function toggleSync(idx) {
  const pair = config.syncPairs[idx];
  if (!pair) return;
  if (pair.status === 'syncing') {
    pair.status = 'paused';
  } else {
    pair.status = 'syncing';
    simulateSyncProgress(idx);
  }
  renderSyncPairs();
  saveConfig();
}

function showPairMenu(e, idx) {
  e.stopPropagation();
  // Простое confirm для удаления
  if (confirm('Удалить эту пару синхронизации?')) {
    config.syncPairs.splice(idx, 1);
    renderSyncPairs();
    saveConfig();
  }
}

// ── Simulate sync (demo, пока нет реального SFTP) ────────────────────────
function simulateSyncProgress(idx) {
  const pair = config.syncPairs[idx];
  if (!pair || pair.status !== 'syncing') return;

  const files = ['config.js', 'index.html', 'app.js', 'styles.css', 'image.png'];
  let i = 0;

  const interval = setInterval(() => {
    if (!config.syncPairs[idx] || config.syncPairs[idx].status !== 'syncing') {
      clearInterval(interval); return;
    }
    if (i >= files.length) {
      clearInterval(interval);
      config.syncPairs[idx].status = 'idle';
      config.syncPairs[idx].lastSync = Date.now();
      sessionSynced += files.length;
      renderSyncPairs();
      updateDashboard();
      saveConfig();
      return;
    }
    addActivity({ file: files[i], size: Math.round(Math.random() * 500 + 10) + ' KB', path: pair.remotePath, done: true });
    i++;
  }, 800);
}

// ── Activity ──────────────────────────────────────────────────────────────
function addActivity(item) {
  activityLog.unshift({ ...item, time: Date.now() });
  if (activityLog.length > 200) activityLog.pop();
  renderLiveActivity();
  renderActivityLog();
}

const fileIconMap = {
  js: 'code', ts: 'code', jsx: 'code', tsx: 'code',
  html: 'html', css: 'style', png: 'image', jpg: 'image', jpeg: 'image',
  gif: 'gif', mp4: 'video_file', mp3: 'audio_file', pdf: 'picture_as_pdf',
  zip: 'folder_zip', txt: 'description', json: 'data_object',
};
function fileIcon(name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  return fileIconMap[ext] || 'description';
}

function renderLiveActivity() {
  const el = document.getElementById('live-activity');
  if (!el) return;
  const recent = activityLog.slice(0, 5);
  if (!recent.length) { el.innerHTML = '<div class="text-on-surface-variant text-sm text-center py-4 opacity-50">Нет активности</div>'; return; }
  el.innerHTML = recent.map(item => `
    <div class="flex items-center gap-md p-md rounded-lg hover:bg-surface-container-high transition-colors">
      <div class="p-xs bg-surface-bright rounded text-primary flex-shrink-0">
        <span class="material-symbols-outlined text-lg">${fileIcon(item.file)}</span>
      </div>
      <div class="flex-1 overflow-hidden">
        <p class="truncate font-body-md text-on-surface">${H(item.file)}</p>
        <p class="text-[10px] text-on-surface-variant">${H(item.size || '')} • ${H(item.path || '')}</p>
      </div>
      <span class="material-symbols-outlined ${item.done ? 'text-tertiary' : 'text-secondary animate-pulse'} text-sm">
        ${item.done ? 'check_circle' : 'sync'}
      </span>
    </div>
  `).join('');
}

function renderActivityLog() {
  const el = document.getElementById('activity-log-list');
  if (!el) return;
  if (!activityLog.length) { el.innerHTML = '<div class="text-center py-8 opacity-50">Лог пуст</div>'; return; }
  el.innerHTML = activityLog.map(item => `
    <div class="flex items-center gap-md p-md rounded-lg hover:bg-surface-container transition-colors">
      <span class="material-symbols-outlined text-primary">${fileIcon(item.file)}</span>
      <div class="flex-1">
        <span class="text-on-surface">${H(item.file)}</span>
        <span class="text-on-surface-variant text-xs ml-md">${H(item.path || '')}</span>
      </div>
      <span class="text-on-surface-variant text-[11px] font-mono">${fmtAgo(item.time)}</span>
      <span class="material-symbols-outlined text-sm ${item.done ? 'text-tertiary' : 'text-secondary'}">
        ${item.done ? 'check_circle' : 'sync'}
      </span>
    </div>
  `).join('');
}

function clearActivity() {
  activityLog = [];
  renderLiveActivity();
  renderActivityLog();
}

// ── Dashboard ─────────────────────────────────────────────────────────────
function updateDashboard() {
  const el = document.getElementById('dash-synced');
  if (el) el.textContent = sessionSynced || '—';
  const pairs = document.getElementById('dash-pairs');
  if (pairs) pairs.textContent = (config.syncPairs || []).length;
  const stat = document.getElementById('stat-synced');
  if (stat) stat.textContent = sessionSynced;
}

function syncAll() {
  (config.syncPairs || []).forEach((p, i) => {
    if (p.status !== 'syncing') { p.status = 'syncing'; simulateSyncProgress(i); }
  });
  renderSyncPairs();
}

// ── Add Folder Modal ──────────────────────────────────────────────────────
function openAddFolderModal() {
  document.getElementById('af-local').value = '';
  document.getElementById('af-remote').value = '';
  document.getElementById('af-name').value = '';
  document.getElementById('af-direction').value = 'upload';
  document.getElementById('af-schedule').value = 'manual';
  document.getElementById('add-folder-modal').classList.add('open');
}

function closeAddFolderModal() {
  document.getElementById('add-folder-modal').classList.remove('open');
}

async function pickLocalFolder() {
  const folder = await window.api.pickFolder();
  if (folder) document.getElementById('af-local').value = folder;
}

function confirmAddFolder() {
  const local  = document.getElementById('af-local').value.trim();
  const remote = document.getElementById('af-remote').value.trim();
  if (!local || !remote) { alert('Укажите локальную и серверную папку'); return; }

  config.syncPairs.push({
    localPath:  local,
    remotePath: remote,
    name:       document.getElementById('af-name').value.trim() || null,
    direction:  document.getElementById('af-direction').value,
    schedule:   document.getElementById('af-schedule').value,
    status:     'idle',
    lastSync:   null,
  });

  saveConfig();
  renderSyncPairs();
  updateDashboard();
  closeAddFolderModal();
}

// ── Conflict Modal ────────────────────────────────────────────────────────
let _conflictCallback = null;

function openConflictModal(filename, freeName, cb) {
  _conflictCallback = cb;
  document.getElementById('cm-filename').textContent = filename;
  document.getElementById('cm-freename').textContent = freeName;
  document.getElementById('cm-desc').textContent = 'Файл уже существует на сервере. Что сделать?';
  document.querySelector('input[name="cm-choice"][value="rename"]').checked = true;
  document.getElementById('conflict-modal').classList.add('open');
}

function closeConflictModal() {
  document.getElementById('conflict-modal').classList.remove('open');
  _conflictCallback = null;
}

function confirmConflict() {
  const choice = document.querySelector('input[name="cm-choice"]:checked')?.value || 'rename';
  closeConflictModal();
  if (_conflictCallback) _conflictCallback(choice);
}

// ── File Browser ──────────────────────────────────────────────────────────
function openFileBrowser() {
  const url = (config.serverUrl || 'http://77.73.135.98:3000') + '/files';
  // В Electron открываем во внешнем браузере
  require('electron').shell?.openExternal(url);
}

// ── Settings ──────────────────────────────────────────────────────────────
function applyConfigToUI() {
  const get = id => document.getElementById(id);
  if (get('cfg-server-url'))    get('cfg-server-url').value    = config.serverUrl || '';
  if (get('cfg-username'))      get('cfg-username').value      = config.username || '';
  if (get('cfg-password'))      get('cfg-password').value      = config.password || '';
  if (get('cfg-conflict-mode')) get('cfg-conflict-mode').value = config.conflictMode || 'ask';
  if (get('cfg-max-size'))      get('cfg-max-size').value      = config.maxSizeMb || 500;
  if (get('cfg-max-size-unit')) get('cfg-max-size-unit').value = config.maxSizeUnit || 'mb';
  if (get('cfg-exclude-ext'))   get('cfg-exclude-ext').value   = config.excludeExt || '';
  if (get('cfg-tray'))          get('cfg-tray').checked        = !!config.minimizeToTray;
  if (get('cfg-autostart'))     get('cfg-autostart').checked   = !!config.startWithWindows;
}

function saveSettings() {
  config.serverUrl      = document.getElementById('cfg-server-url')?.value.trim() || config.serverUrl;
  config.username       = document.getElementById('cfg-username')?.value.trim()   || '';
  config.password       = document.getElementById('cfg-password')?.value          || '';
  config.conflictMode   = document.getElementById('cfg-conflict-mode')?.value     || 'ask';
  config.maxSizeMb      = parseInt(document.getElementById('cfg-max-size')?.value) || 500;
  config.maxSizeUnit    = document.getElementById('cfg-max-size-unit')?.value      || 'mb';
  config.excludeExt     = document.getElementById('cfg-exclude-ext')?.value.trim() || '';
  config.minimizeToTray = document.getElementById('cfg-tray')?.checked ?? true;
  config.startWithWindows = document.getElementById('cfg-autostart')?.checked ?? false;
  saveConfig();
  const btn = document.querySelector('[onclick="saveSettings()"]');
  if (btn) { const orig = btn.textContent; btn.textContent = '✓ Сохранено'; setTimeout(() => btn.textContent = orig, 1500); }
  checkConnection();
}

async function testConnection() {
  const label = document.getElementById('test-conn-label');
  if (label) label.textContent = 'Проверяю...';
  const url = (document.getElementById('cfg-server-url')?.value.trim() || config.serverUrl).replace(/\/$/, '');
  try {
    const res = await fetch(url + '/login', { signal: AbortSignal.timeout(5000) });
    // Любой HTTP-ответ = сервер работает
    if (label) label.textContent = '✓ Сервер доступен (HTTP ' + res.status + ')';
    setConnStatus('connected');
  } catch (e) {
    if (label) label.textContent = '✗ Нет соединения — ' + (e.message || 'timeout');
    setConnStatus('offline');
  }
  setTimeout(() => { if (label) label.textContent = 'Проверить соединение'; }, 4000);
}

// ── Helpers ───────────────────────────────────────────────────────────────
function H(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtAgo(ts) {
  if (!ts) return '—';
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60)   return diff + ' сек. назад';
  if (diff < 3600) return Math.floor(diff/60) + ' мин. назад';
  if (diff < 86400)return Math.floor(diff/3600) + ' ч. назад';
  return Math.floor(diff/86400) + ' д. назад';
}

function saveConfig() {
  window.api.saveConfig(config);
}

// ── Keyboard ──────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeConflictModal();
    closeAddFolderModal();
  }
});
