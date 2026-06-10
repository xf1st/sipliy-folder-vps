/* VPS Sync Manager — renderer */
let config = { serverUrl:'', username:'', password:'', syncPairs:[], minimizeToTray:true };
let actLog = [];
let pairStatuses = {}; // pairId → 'idle'|'syncing'|'watching'|'error'

// ── Init ──────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  config = await window.api.loadConfig();
  applyConfigToUI();
  navigateTo('sync-folders');
  updateClock();
  setInterval(updateClock, 30000);

  // Engine events
  window.api.onLog(({ level, msg }) => addLog(level, msg));
  window.api.onStatus(({ pairId, status }) => {
    pairStatuses[pairId] = status;
    if (config.syncPairs[pairId]) config.syncPairs[pairId].status = status;
    renderSyncPairs();
  });
  window.api.onProgress(({ pairId, msg, pct }) => {
    const el = document.getElementById('pair-progress-' + pairId);
    if (el) el.textContent = pct < 100 ? `${pct}% — ${msg}` : '✓ Готово';
  });
  window.api.onTraySync(() => syncAll());

  // Auto-connect if credentials set
  if (config.serverUrl && config.username && config.password) {
    checkConnection();
  }

  renderSyncPairs();
});

// ── Nav ───────────────────────────────────────────────────────────────────
function navigateTo(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(a => a.classList.remove('active'));
  const page = document.getElementById('page-' + pageId);
  if (page) page.classList.add('active');
  const nav = document.querySelector(`[data-page="${pageId}"]`);
  if (nav) nav.classList.add('active');
}
document.querySelectorAll('.nav-item').forEach(el =>
  el.addEventListener('click', () => navigateTo(el.dataset.page)));

// ── Clock ─────────────────────────────────────────────────────────────────
function updateClock() {
  const el = document.getElementById('status-time');
  if (el) el.textContent = new Date().toLocaleString('ru',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
}

// ── Connection ────────────────────────────────────────────────────────────
async function checkConnection() {
  setConnUI('checking');
  const r = await window.api.connect();
  setConnUI(r.ok ? 'connected' : 'offline');
  if (!r.ok) addLog('error', 'Соединение: ' + (r.error || 'ошибка'));
}

function setConnUI(state) {
  const dot = document.getElementById('conn-dot');
  const lbl = document.getElementById('conn-label');
  const url = document.getElementById('server-url-label');
  if (url) url.textContent = (config.serverUrl || '—').replace(/^https?:\/\//, '');
  const m = { connected:{c:'bg-tertiary',t:'text-tertiary',l:'Connected'}, offline:{c:'bg-error',t:'text-error',l:'Offline'}, checking:{c:'bg-yellow-400',t:'text-yellow-400',l:'Connecting...'} };
  const s = m[state] || m.offline;
  if (dot) dot.className = 'w-2 h-2 rounded-full ' + s.c;
  if (lbl) lbl.className = 'font-label-md text-label-md ' + s.t, lbl.textContent = s.l;
}

// ── Sync Pairs ────────────────────────────────────────────────────────────
function renderSyncPairs() {
  const list  = document.getElementById('sync-pairs-list');
  const empty = document.getElementById('sync-empty');
  if (!list) return;
  list.querySelectorAll('.sync-card').forEach(c => c.remove());
  const pairs = config.syncPairs || [];
  if (!pairs.length) { if (empty) empty.style.display='flex'; return; }
  if (empty) empty.style.display = 'none';
  pairs.forEach((pair, idx) => list.appendChild(buildCard(pair, idx)));
}

function buildCard(pair, idx) {
  const st = pairStatuses[idx] || pair.status || 'idle';
  const badgeMap = {
    idle:     'bg-tertiary/15 text-tertiary',
    syncing:  'bg-secondary-container/15 text-secondary',
    watching: 'bg-primary/15 text-primary',
    error:    'bg-error/15 text-error',
  };
  const dotMap = { idle:'bg-tertiary', syncing:'bg-secondary animate-pulse', watching:'bg-primary animate-pulse', error:'bg-error' };
  const labelMap = { idle:'Synced', syncing:'Syncing...', watching:'Watching', error:'Error' };
  const dirIcon = pair.direction==='both'?'sync_alt':pair.direction==='download'?'arrow_back':'arrow_forward';
  const name = pair.name || path.basename(pair.localPath||'') || 'Folder';

  const card = document.createElement('div');
  card.className = 'sync-card mica-effect rounded-xl p-lg border border-white/5 hover:border-primary/20 transition-all duration-300';
  card.innerHTML = `
    <div class="flex justify-between items-start mb-lg">
      <div class="flex gap-md">
        <div class="w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center text-primary">
          <span class="material-symbols-outlined text-2xl" style="font-variation-settings:'FILL' 1">cloud_sync</span>
        </div>
        <div>
          <h3 class="font-headline-sm text-headline-sm">${H(name)}</h3>
          <p class="text-on-surface-variant font-label-md text-label-md mt-1">${H(pair.localPath||'')}</p>
        </div>
      </div>
      <span class="${badgeMap[st]||badgeMap.idle} px-md py-xs rounded-full flex items-center gap-sm font-label-md text-label-md">
        <span class="w-2 h-2 rounded-full ${dotMap[st]||dotMap.idle}"></span>${labelMap[st]||st}
      </span>
    </div>
    <div class="flex items-center gap-lg py-md border-y border-white/5 mb-lg">
      <span class="material-symbols-outlined text-on-surface-variant">${dirIcon}</span>
      <div class="flex-1 flex items-center gap-sm text-on-surface-variant font-label-md overflow-hidden">
        <span class="material-symbols-outlined text-sm flex-shrink-0">storage</span>
        <span class="truncate">${H(pair.remotePath||'')}</span>
      </div>
    </div>
    <div id="pair-progress-${idx}" class="text-[11px] text-on-surface-variant mb-sm font-mono min-h-[14px]"></div>
    <div class="flex justify-between items-center">
      <span class="text-on-surface-variant font-label-md text-label-md">
        ${pair.lastSync ? 'Sync: ' + fmtAgo(pair.lastSync) : 'Ещё не синхронизировалась'}
      </span>
      <div class="flex gap-xs">
        <button onclick="syncOnePair(${idx})" class="p-sm text-on-surface-variant hover:text-primary transition-colors" title="Синхронизировать сейчас">
          <span class="material-symbols-outlined text-[18px]">sync</span>
        </button>
        <button onclick="toggleWatch(${idx})" class="p-sm ${st==='watching'?'text-primary':'text-on-surface-variant'} hover:text-primary transition-colors" title="${st==='watching'?'Остановить слежение':'Следить за изменениями'}">
          <span class="material-symbols-outlined text-[18px]">${st==='watching'?'visibility_off':'visibility'}</span>
        </button>
        <button onclick="removePair(${idx})" class="p-sm text-on-surface-variant hover:text-error transition-colors" title="Удалить">
          <span class="material-symbols-outlined text-[18px]">delete</span>
        </button>
      </div>
    </div>
  `;
  return card;
}

// ── Sync actions ──────────────────────────────────────────────────────────
async function syncOnePair(idx) {
  pairStatuses[idx] = 'syncing';
  renderSyncPairs();
  addLog('info', `Синхронизирую пару #${idx+1}...`);
  const r = await window.api.syncPair(idx);
  pairStatuses[idx] = r.ok ? 'idle' : 'error';
  if (config.syncPairs[idx]) { config.syncPairs[idx].status = pairStatuses[idx]; config.syncPairs[idx].lastSync = Date.now(); }
  if (r.ok) addLog('info', `✓ Пара #${idx+1}: ↑${r.uploaded||0} ↓${r.downloaded||0}`);
  else      addLog('error', `✗ Пара #${idx+1}: ${r.error}`);
  renderSyncPairs();
  saveConfig();
}

async function syncAll() {
  addLog('info', 'Синхронизирую все пары...');
  const r = await window.api.syncAll();
  if (r.ok) {
    r.results.forEach(res => {
      pairStatuses[res.pairId] = res.ok ? 'idle' : 'error';
      if (config.syncPairs[res.pairId]) config.syncPairs[res.pairId].status = pairStatuses[res.pairId];
    });
    addLog('info', '✓ Синхронизация завершена');
  } else {
    addLog('error', r.error || 'Ошибка синхронизации');
  }
  renderSyncPairs();
}

async function toggleWatch(idx) {
  if (pairStatuses[idx] === 'watching') {
    await window.api.watchStop(idx);
    pairStatuses[idx] = 'idle';
    addLog('info', `Слежение за парой #${idx+1} остановлено`);
  } else {
    const r = await window.api.watchStart(idx);
    if (r.ok) { pairStatuses[idx] = 'watching'; addLog('info', `Слежу за парой #${idx+1}`); }
    else       addLog('error', `Не удалось: ${r.error}`);
  }
  if (config.syncPairs[idx]) config.syncPairs[idx].status = pairStatuses[idx];
  renderSyncPairs();
}

function removePair(idx) {
  window.api.watchStop(idx);
  config.syncPairs.splice(idx, 1);
  delete pairStatuses[idx];
  renderSyncPairs();
  saveConfig();
}

// ── Add Folder Modal ──────────────────────────────────────────────────────
function openAddFolderModal() {
  ['af-local','af-remote','af-name'].forEach(id => { const el=document.getElementById(id); if(el)el.value=''; });
  const d = document.getElementById('af-direction'); if(d) d.value='upload';
  document.getElementById('add-folder-modal').classList.add('open');
}
function closeAddFolderModal() { document.getElementById('add-folder-modal').classList.remove('open'); }

async function pickLocalFolder() {
  const p = await window.api.pickFolder();
  if (p) document.getElementById('af-local').value = p;
}

function confirmAddFolder() {
  const local  = document.getElementById('af-local')?.value.trim();
  const remote = document.getElementById('af-remote')?.value.trim();
  if (!local || !remote) { alert('Укажите обе папки'); return; }
  config.syncPairs.push({
    localPath:  local,
    remotePath: remote,
    name:       document.getElementById('af-name')?.value.trim() || null,
    direction:  document.getElementById('af-direction')?.value || 'upload',
    status:     'idle',
    lastSync:   null,
  });
  renderSyncPairs();
  closeAddFolderModal();
  saveConfig();
}

// ── Settings ──────────────────────────────────────────────────────────────
function applyConfigToUI() {
  const set = (id, v) => { const el=document.getElementById(id); if(el) { if(el.type==='checkbox') el.checked=!!v; else el.value=v||''; } };
  set('cfg-server-url', config.serverUrl);
  set('cfg-username',   config.username);
  set('cfg-password',   config.password);
  set('cfg-tray',       config.minimizeToTray);
  const url = document.getElementById('server-url-label');
  if (url) url.textContent = (config.serverUrl||'—').replace(/^https?:\/\//,'');
}

function saveSettings() {
  config.serverUrl      = document.getElementById('cfg-server-url')?.value.trim()  || config.serverUrl;
  config.username       = document.getElementById('cfg-username')?.value.trim()     || '';
  config.password       = document.getElementById('cfg-password')?.value           || '';
  config.minimizeToTray = document.getElementById('cfg-tray')?.checked ?? true;
  saveConfig();
  checkConnection();
  const btn = document.querySelector('[onclick="saveSettings()"]');
  if (btn) { const t=btn.textContent; btn.textContent='✓ Сохранено'; setTimeout(()=>btn.textContent=t,1500); }
}

function saveConfig() { window.api.saveConfig(config); }

// ── Activity Log ──────────────────────────────────────────────────────────
function addLog(level, msg) {
  actLog.unshift({ level, msg, ts: Date.now() });
  if (actLog.length > 500) actLog.pop();
  renderActivityLog();
}

function renderActivityLog() {
  const el = document.getElementById('activity-log-list');
  if (!el) return;
  if (!actLog.length) { el.innerHTML = '<div class="text-center py-8 opacity-50">Лог пуст</div>'; return; }
  const colors = { info:'text-on-surface', warn:'text-yellow-400', error:'text-error' };
  el.innerHTML = actLog.slice(0,100).map(e =>
    `<div class="flex items-center gap-md py-sm border-b border-white/5 text-sm">
      <span class="font-mono text-[10px] text-on-surface-variant flex-shrink-0">${new Date(e.ts).toLocaleTimeString('ru')}</span>
      <span class="${colors[e.level]||colors.info} flex-1">${H(e.msg)}</span>
    </div>`
  ).join('');
}

function clearLog() { actLog = []; renderActivityLog(); }

// ── Helpers ───────────────────────────────────────────────────────────────
const path = { basename: p => (p||'').split(/[\\/]/).pop() };
function H(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtAgo(ts) {
  if (!ts) return '—';
  const d = Math.floor((Date.now()-ts)/1000);
  return d<60 ? d+'с назад' : d<3600 ? Math.floor(d/60)+'м назад' : d<86400 ? Math.floor(d/3600)+'ч назад' : Math.floor(d/86400)+'д назад';
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.getElementById('add-folder-modal')?.classList.remove('open');
  }
});
