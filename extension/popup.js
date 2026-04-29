// Sipliy Folder VPS — popup script v2.3 (multi-account)

const $ = id => document.getElementById(id);

// ─── Utilities ────────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function normalizeUrl(u) {
  u = (u || '').trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}
function fmt(b) {
  if (!b || b < 0) return '—';
  const units = ['B','KB','MB','GB'];
  let i = 0, v = b;
  while (v >= 1024 && i < 3) { v /= 1024; i++; }
  return v.toFixed(1) + ' ' + units[i];
}
function fmtDate(ts) {
  return new Date(ts).toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
}
function fileEmoji(name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  return { mp4:'🎬',mkv:'🎬',avi:'🎬',mov:'🎬',webm:'🎬',mp3:'🎵',flac:'🎵',wav:'🎵',
           zip:'📦',rar:'📦','7z':'📦',tar:'📦',gz:'📦',exe:'💿',msi:'💿',iso:'💿',
           dmg:'🍎',apk:'📱',pdf:'📄',jpg:'🖼',jpeg:'🖼',png:'🖼',gif:'🖼',webp:'🖼' }[ext] || '📁';
}
function genId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ─── Account storage ──────────────────────────────────────
async function loadAccountsData() {
  const d = await new Promise(r =>
    chrome.storage.sync.get(['accounts', 'activeAccountId', 'siteUrl', 'serverUrl', 'token'], r)
  );
  let accounts = Array.isArray(d.accounts) ? d.accounts : [];
  let activeAccountId = d.activeAccountId || null;
  let siteUrl = normalizeUrl(d.siteUrl || d.serverUrl || accounts.find(a => a.url)?.url || 'https://sipliyfolder.ru');

  // Migration: old single-account format → accounts array
  if (!accounts.length && d.serverUrl && d.token) {
    const id = genId();
    accounts = [{ id, name: 'Мой аккаунт', token: d.token }];
    activeAccountId = id;
    siteUrl = normalizeUrl(d.serverUrl);
    await new Promise(r => chrome.storage.sync.set({ accounts, activeAccountId, siteUrl }, r));
  } else {
    let changed = false;
    accounts = accounts.map(a => {
      if (a.url) changed = true;
      const { url, ...rest } = a;
      return rest;
    });
    if (changed || !d.siteUrl) await new Promise(r => chrome.storage.sync.set({ accounts, activeAccountId, siteUrl }, r));
  }

  if (!activeAccountId && accounts.length) activeAccountId = accounts[0].id;
  return { accounts, activeAccountId, siteUrl };
}

async function saveAccountsData(accounts, activeAccountId, siteUrl) {
  const payload = { accounts, activeAccountId };
  if (siteUrl !== undefined) payload.siteUrl = normalizeUrl(siteUrl);
  return new Promise(r => chrome.storage.sync.set(payload, r));
}

function getActiveAccount(accounts, activeAccountId) {
  return accounts.find(a => a.id === activeAccountId) || accounts[0] || null;
}

// ─── Config for downloads (active account) ────────────────
async function getConfig() {
  const { accounts, activeAccountId, siteUrl } = await loadAccountsData();
  const acc = getActiveAccount(accounts, activeAccountId);
  if (!acc) return { serverUrl: '', token: '', accountId: null };
  return { serverUrl: siteUrl, token: acc.token, accountId: acc.id };
}

// ─── Tab switching ────────────────────────────────────────
function switchTab(tabName) {
  document.querySelectorAll('.tab-btn, .panel').forEach(el => el.classList.remove('active'));
  document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
  $('panel-' + tabName).classList.add('active');
  if (tabName === 'downloads') loadDownloadsTab();
}
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// ─── Settings: Render accounts list ───────────────────────
const dotsCache = {};

function renderAccountsList(accounts, activeAccountId) {
  const el = $('accounts-list');
  if (!accounts.length) {
    el.innerHTML = '<div class="empty-state" style="padding:16px 0"><div class="icon">🔐</div>Нет аккаунтов. Добавьте первый!</div>';
    return;
  }
  el.innerHTML = accounts.map(a => {
    const isActive = a.id === activeAccountId;
    const dot = dotsCache[a.id];
    const dotClass = dot === true ? 'ok' : dot === false ? 'err' : '';
    return `<div class="account-card${isActive ? ' active' : ''}" data-id="${escHtml(a.id)}">
      <div class="acc-avatar">${escHtml((a.name || '?')[0].toUpperCase())}</div>
      <div class="acc-info">
        <div class="acc-name-row">
          <span class="acc-name-text">${escHtml(a.name || 'Аккаунт')}</span>
          ${isActive ? '<span class="active-badge">Активный</span>' : ''}
          <span class="acc-dot ${dotClass}" data-dot-id="${escHtml(a.id)}"></span>
        </div>
        <div class="acc-url">Пользователь CloudSpace</div>
      </div>
      <div class="acc-actions">
        <button class="acc-btn" data-action="edit" data-id="${escHtml(a.id)}">✏</button>
        ${!isActive ? `<button class="acc-btn" data-action="switch" data-id="${escHtml(a.id)}">Войти</button>` : ''}
        <button class="acc-btn danger" data-action="delete" data-id="${escHtml(a.id)}">✕</button>
      </div>
    </div>`;
  }).join('');
}

$('accounts-list').addEventListener('click', async e => {
  const btn = e.target.closest('[data-action]');
  if (btn) {
    const { action, id } = btn.dataset;
    if      (action === 'edit')   openAccountForm(id);
    else if (action === 'switch') await switchToAccount(id);
    else if (action === 'delete') await deleteAccount(id);
    return;
  }
  const card = e.target.closest('.account-card[data-id]');
  if (card) await switchToAccount(card.dataset.id);
});

// ─── Settings: Account switcher in downloads tab ──────────
function renderAccountSwitcher(accounts, activeAccountId) {
  const el = $('account-switcher');
  if (accounts.length <= 1) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.innerHTML = '<div class="switcher">' +
    accounts.map(a =>
      `<div class="sw-pill${a.id === activeAccountId ? ' active' : ''}" data-switch-id="${escHtml(a.id)}">${escHtml(a.name || 'Аккаунт')}</div>`
    ).join('') + '</div>';
}

$('account-switcher').addEventListener('click', async e => {
  const pill = e.target.closest('[data-switch-id]');
  if (!pill) return;
  await switchToAccount(pill.dataset.switchId);
});

// ─── Settings: Header subtitle ────────────────────────────
function updateHeaderSub(accounts, activeAccountId) {
  const acc = getActiveAccount(accounts, activeAccountId);
  $('hd-sub').textContent = !acc
    ? 'Скачивание правым кликом по ссылке'
    : (acc.name || 'Аккаунт CloudSpace');
}

// ─── Settings: Init & connection dots ─────────────────────
async function initSettings() {
  const { accounts, activeAccountId, siteUrl } = await loadAccountsData();
  $('site-url-inp').value = siteUrl || '';
  renderAccountsList(accounts, activeAccountId);
  renderAccountSwitcher(accounts, activeAccountId);
  updateHeaderSub(accounts, activeAccountId);
  checkAndUpdateDots(accounts, siteUrl);
  return { accounts, activeAccountId, siteUrl };
}

async function checkAndUpdateDots(accounts, siteUrl) {
  for (const acc of accounts) {
    testConn(siteUrl, acc.token).then(r => {
      dotsCache[acc.id] = r.ok;
      const dot = document.querySelector(`[data-dot-id="${CSS.escape(acc.id)}"]`);
      if (dot) dot.className = 'acc-dot ' + (r.ok ? 'ok' : 'err');
    });
  }
}

// ─── Settings: switchToAccount ────────────────────────────
async function switchToAccount(id) {
  const { accounts, activeAccountId, siteUrl } = await loadAccountsData();
  if (id === activeAccountId) return;
  await saveAccountsData(accounts, id, siteUrl);
  await initSettings();
  if ($('panel-downloads').classList.contains('active')) {
    clearTimeout(pollTimer);
    loadDownloadsTab();
  }
}

// ─── Settings: deleteAccount ──────────────────────────────
async function deleteAccount(id) {
  const { accounts, activeAccountId, siteUrl } = await loadAccountsData();
  const acc = accounts.find(a => a.id === id);
  if (!acc) return;
  if (!confirm(`Удалить аккаунт «${acc.name || 'Аккаунт'}»?`)) return;

  const newAccounts = accounts.filter(a => a.id !== id);
  const newActiveId = activeAccountId === id
    ? (newAccounts[0]?.id || null)
    : activeAccountId;
  await saveAccountsData(newAccounts, newActiveId, siteUrl);

  delete dotsCache[id];

  // Remove readyFiles belonging to this account
  const { readyFiles: rf = [] } = await new Promise(r => chrome.storage.local.get('readyFiles', r));
  await new Promise(r => chrome.storage.local.set(
    { readyFiles: rf.filter(f => f.accountId !== id) }, r
  ));

  await initSettings();

  // Reload downloads if open
  if ($('panel-downloads').classList.contains('active')) {
    clearTimeout(pollTimer);
    loadDownloadsTab();
  }
}

// ─── Account form: open / close / save ────────────────────
let editingAccountId = null;

function openAccountForm(accountId = null) {
  editingAccountId = accountId;
  $('accounts-view').style.display = 'none';
  $('account-form-view').style.display = 'block';
  $('form-title').textContent = accountId ? 'Изменить аккаунт' : 'Добавить аккаунт';
  setFormStatus('', '');

  if (accountId) {
    loadAccountsData().then(({ accounts }) => {
      const a = accounts.find(x => x.id === accountId);
      if (a) {
        $('acc-name-inp').value  = a.name  || '';
        $('acc-token-inp').value = a.token || '';
      }
    });
  } else {
    $('acc-name-inp').value  = '';
    $('acc-token-inp').value = '';
  }
}

function closeAccountForm() {
  editingAccountId = null;
  $('account-form-view').style.display = 'none';
  $('accounts-view').style.display = 'block';
}

function setFormStatus(cls, msg) {
  const el = $('form-status');
  el.className = cls ? 'toast ' + cls : '';
  el.textContent = msg;
}

$('form-back-btn').addEventListener('click', closeAccountForm);

$('acc-eye').addEventListener('click', () => {
  const inp = $('acc-token-inp');
  inp.type = inp.type === 'password' ? 'text' : 'password';
});

$('open-site-form').addEventListener('click', e => {
  e.preventDefault();
  chrome.tabs.create({ url: normalizeUrl($('site-url-inp').value) || 'https://sipliyfolder.ru' });
});

$('add-account-btn').addEventListener('click', () => openAccountForm(null));

$('site-url-inp').addEventListener('change', async () => {
  const { accounts, activeAccountId } = await loadAccountsData();
  await saveAccountsData(accounts, activeAccountId, $('site-url-inp').value);
  checkAndUpdateDots(accounts, normalizeUrl($('site-url-inp').value));
});

$('form-test-btn').addEventListener('click', async () => {
  const url   = normalizeUrl($('site-url-inp').value);
  const token = $('acc-token-inp').value.trim();
  if (!url || !token) { setFormStatus('err', '✕ Введите URL и токен'); return; }
  $('form-test-btn').disabled = true;
  setFormStatus('info', 'Проверяем…');
  const r = await testConn(url, token);
  $('form-test-btn').disabled = false;
  r.ok ? setFormStatus('ok', '✓ Соединение работает') : setFormStatus('err', '✕ ' + r.error);
});

$('form-save-btn').addEventListener('click', async () => {
  const name  = $('acc-name-inp').value.trim();
  const url   = normalizeUrl($('site-url-inp').value);
  const token = $('acc-token-inp').value.trim();
  if (!url || !token) { setFormStatus('err', '✕ Заполните URL и токен'); return; }

  const { accounts, activeAccountId } = await loadAccountsData();

  if (editingAccountId) {
    const idx = accounts.findIndex(a => a.id === editingAccountId);
    if (idx >= 0) accounts[idx] = { ...accounts[idx], name: name || 'Аккаунт', token };
    await saveAccountsData(accounts, activeAccountId, url);
  } else {
    const newAcc = { id: genId(), name: name || 'Аккаунт', token };
    accounts.push(newAcc);
    // First ever account → make it active
    await saveAccountsData(accounts, accounts.length === 1 ? newAcc.id : activeAccountId, url);
  }

  closeAccountForm();
  await initSettings();
});

// ─── Shared: testConn ─────────────────────────────────────
async function testConn(url, token) {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url + '/api/add-ext', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'url=',
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'Неверный токен' };
    if (res.status === 400 || res.ok) return { ok: true };
    return { ok: false, error: 'HTTP ' + res.status };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'Таймаут' : e.message };
  }
}

// ─── Global settings ──────────────────────────────────────
chrome.storage.local.get('autoDownload', d => {
  $('auto-dl').checked = d.autoDownload !== false;
});
$('auto-dl').addEventListener('change', () =>
  chrome.storage.local.set({ autoDownload: $('auto-dl').checked })
);

$('test-dl-btn').addEventListener('click', async () => {
  const btn = $('test-dl-btn');
  btn.disabled = true; btn.textContent = 'Проверяем…';
  const warn = $('perm-warn');
  const inst = $('perm-instructions');

  let errorType = null, errorMsg = '';
  if (typeof chrome.downloads === 'undefined') {
    errorType = 'no-permission';
  } else {
    try {
      const blob = new Blob(['sipliy-test'], { type: 'text/plain' });
      const blobUrl = URL.createObjectURL(blob);
      const id = await chrome.downloads.download({ url: blobUrl, filename: 'sipliy-test.txt', saveAs: false });
      URL.revokeObjectURL(blobUrl);
      setTimeout(() => chrome.downloads.cancel(id, () => chrome.downloads.erase({ id })), 500);
    } catch (e) { errorMsg = e.message || ''; errorType = 'blocked'; }
  }

  if (!errorType) {
    warn.style.display = 'none';
  } else {
    warn.style.display = 'flex';
    const isEdge = navigator.userAgent.includes('Edg/');
    const { siteUrl } = await loadAccountsData();
    const serverUrl = escHtml(siteUrl || 'адрес вашего сервера');
    const browserName = isEdge ? 'Edge' : 'Chrome';
    if (errorType === 'no-permission') {
      inst.innerHTML = `<b>Причина:</b> расширению не выдано разрешение на загрузку файлов.<br>
        <b>Решение — перезагрузить расширение:</b>
        <ol><li>Откройте <b>${isEdge ? 'edge' : 'chrome'}://extensions</b></li>
        <li>Найдите <b>Sipliy Folder VPS</b></li>
        <li>Нажмите кнопку <b>↻ обновить</b></li>
        <li>Снова нажмите «Тест»</li></ol>`;
    } else {
      inst.innerHTML = `<b>Причина:</b> браузер заблокировал автозагрузку.<br>
        <b>Решение:</b>
        <ol><li>Откройте настройки ${browserName}: <b>⋯</b> → <b>Настройки</b></li>
        <li>Перейдите в <b>Конфиденциальность и безопасность</b></li>
        <li>Откройте <b>Настройки сайтов</b></li>
        <li>Найдите <b>Автоматическая загрузка файлов</b></li>
        <li>Добавьте <b>${serverUrl}</b> в список разрешённых</li>
        <li>Снова нажмите «Тест»</li></ol>
        ${errorMsg ? '<span style="font-size:.67rem;color:#92400e;margin-top:4px;display:block">Ошибка: ' + escHtml(errorMsg) + '</span>' : ''}`;
    }
  }

  btn.textContent = '🧪 Тест авто-загрузки на ПК';
  setTimeout(() => { btn.disabled = false; }, 1500);
});

$('open-help').addEventListener('click', e => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
});

// ─── Initialization ───────────────────────────────────────
(async () => {
  const { accounts } = await initSettings();
  if (accounts.length > 0) switchTab('downloads');
})();

// ─── Downloads tab ────────────────────────────────────────
let pollTimer = null;
const SL = { active:'Скачивается', waiting:'В очереди', paused:'Пауза', complete:'Готово', error:'Ошибка' };

async function loadDownloadsTab() {
  clearTimeout(pollTimer);
  await renderDownloads();
  pollTimer = setTimeout(loadDownloadsTab, 2000);
}

async function renderDownloads() {
  const cfg = await getConfig();
  const { accounts, activeAccountId } = await loadAccountsData();
  const activeAcc = getActiveAccount(accounts, activeAccountId);

  // Update switcher
  renderAccountSwitcher(accounts, activeAccountId);

  if (!cfg.serverUrl || !cfg.token) {
    $('ready-section').style.display = 'none';
    $('active-list').innerHTML = '<div class="empty-state"><div class="icon">⚙️</div>Добавьте аккаунт в настройках</div>';
    $('file-list').innerHTML = '';
    return;
  }

  // Parallel fetch: downloads + files
  const [dlRes, filesRes] = await Promise.all([
    fetch(cfg.serverUrl + '/api/downloads-ext', { headers: { 'Authorization': 'Bearer ' + cfg.token } }).catch(() => null),
    fetch(cfg.serverUrl + '/api/files-ext',     { headers: { 'Authorization': 'Bearer ' + cfg.token } }).catch(() => null),
  ]);

  let vpsFiles = [];
  if (filesRes && filesRes.ok) vpsFiles = await filesRes.json().catch(() => []);
  const vpsFileNames = new Set(vpsFiles.map(f => f.name));

  // Clean readyFiles: remove deleted VPS files (only for current account), keep other accounts' files
  const { readyFiles: rawReady = [] } = await new Promise(r => chrome.storage.local.get('readyFiles', r));
  const cleaned = rawReady.filter(f => {
    const isThisAcc = !f.accountId || f.accountId === activeAcc?.id;
    return !isThisAcc || vpsFileNames.has(f.name);
  });
  if (cleaned.length !== rawReady.length) {
    await new Promise(r => chrome.storage.local.set({ readyFiles: cleaned }, r));
  }
  // Show only current account's ready files
  const readyFiles = cleaned.filter(f => !f.accountId || f.accountId === activeAcc?.id);

  // ── Ready-to-download section ──
  if (readyFiles.length > 0) {
    $('ready-section').style.display = 'block';
    $('ready-list').innerHTML = readyFiles.map(f => `
      <div class="ready-item" id="ri-${escHtml(encodeURIComponent(f.name))}">
        <div class="ready-icon">${fileEmoji(f.name)}</div>
        <div class="ready-info">
          <div class="ready-name" title="${escHtml(f.name)}">${escHtml(f.name)}</div>
          <div class="ready-meta">${fmt(f.size)} · готово ${fmtDate(f.readyAt)}</div>
        </div>
        <button class="btn-pc" data-url="${escHtml(encodeURIComponent(f.dlUrl))}" data-name="${escHtml(encodeURIComponent(f.name))}" data-account-id="${escHtml(f.accountId || activeAcc?.id || '')}">⬇ На ПК</button>
      </div>`).join('');
  } else {
    $('ready-section').style.display = 'none';
  }

  // ── Active downloads ──
  const activeEl = $('active-list');
  if (!dlRes || !dlRes.ok) {
    activeEl.innerHTML = '<div class="empty-state"><div class="icon">⚠️</div>Нет соединения с сервером</div>';
  } else {
    const dls = await dlRes.json().catch(() => []);
    const ongoing = dls.filter(d => d.status !== 'complete');
    const countEl = $('dl-count');
    ongoing.length > 0
      ? (countEl.textContent = ongoing.length, countEl.classList.add('show'))
      : countEl.classList.remove('show');
    activeEl.innerHTML = ongoing.length
      ? ongoing.map(d => {
          const speed = d.speed ? ' · ' + fmt(d.speed) + '/с' : '';
          return `<div class="dl-item">
            <div class="dl-top">
              <div style="min-width:0;flex:1">
                <div class="dl-name" title="${escHtml(d.name)}">${escHtml(d.name)}</div>
                <div class="dl-meta">${fmt(d.downloaded)} / ${fmt(d.size)}${speed}</div>
              </div>
              <span class="dl-badge ${d.status}">${SL[d.status]||d.status}${d.progress > 0 ? ' '+d.progress+'%' : ''}</span>
            </div>
            <div class="progress-bar"><div class="progress-fill" style="width:${d.progress}%"></div></div>
          </div>`;
        }).join('')
      : '<div class="empty-state"><div class="icon">🎯</div>Нет активных загрузок</div>';
  }

  // ── All VPS files ──
  const fileEl = $('file-list');
  if (!filesRes || !filesRes.ok) {
    fileEl.innerHTML = '<div class="empty-state"><div class="icon">⚠️</div>Нет соединения с сервером</div>';
    return;
  }
  fileEl.innerHTML = vpsFiles.length
    ? vpsFiles.map(f => {
        const dlUrl = cfg.serverUrl + '/api/ext-dl/' + encodeURIComponent(f.name) + '?t=' + encodeURIComponent(cfg.token);
        return `<div class="file-item">
          <div class="file-ico">${fileEmoji(f.name)}</div>
          <div class="file-info">
            <div class="file-name" title="${escHtml(f.name)}">${escHtml(f.name)}</div>
            <div class="file-meta">${fmt(f.size)} · ${fmtDate(new Date(f.mtime).getTime())}</div>
          </div>
          <button class="btn-sm btn-dl" data-url="${escHtml(encodeURIComponent(dlUrl))}" data-name="${escHtml(encodeURIComponent(f.name))}">⬇ На ПК</button>
        </div>`;
      }).join('')
    : '<div class="empty-state"><div class="icon">📂</div>Файлов нет</div>';
}

// ─── Manual URL -> VPS ───────────────────────────────────────────
function guessUrlName(url) {
  try {
    if (/^magnet:/i.test(url)) return 'magnet-download';
    const u = new URL(url);
    const last = decodeURIComponent((u.pathname || '').split('/').filter(Boolean).pop() || '');
    return last || 'url-download';
  } catch (_) {
    return 'url-download';
  }
}

function setManualUrlStatus(kind, text) {
  const el = $('manual-url-status');
  el.className = 'url-status ' + (kind || '');
  el.textContent = text || '';
}

async function addManualUrlDownload() {
  const cfg = await getConfig();
  const btn = $('manual-url-btn');
  const url = $('manual-url-inp').value.trim();
  const filename = $('manual-name-inp').value.trim();

  if (!cfg.serverUrl || !cfg.token) {
    setManualUrlStatus('err', 'Добавьте аккаунт');
    switchTab('settings');
    return;
  }
  if (!/^https?:\/\//i.test(url) && !/^magnet:/i.test(url)) {
    setManualUrlStatus('err', 'Нужна http(s) или magnet ссылка');
    return;
  }

  btn.disabled = true;
  setManualUrlStatus('', 'Отправляю...');
  try {
    const data = await chrome.runtime.sendMessage({ type: 'add-url-download', url, filename });
    if (!data || !data.ok) throw new Error((data && data.error) || 'Ошибка');

    $('manual-url-inp').value = '';
    $('manual-name-inp').value = '';
    setManualUrlStatus('ok', 'Добавлено. Потом само скачается на ПК');
    clearTimeout(pollTimer);
    setTimeout(loadDownloadsTab, 350);
  } catch (e) {
    setManualUrlStatus('err', e.name === 'AbortError' ? 'Сервер не ответил' : (e.message || 'Ошибка'));
  } finally {
    setTimeout(() => { btn.disabled = false; }, 700);
  }
}

// ─── Download button handler (event delegation, CSP-safe) ─
document.addEventListener('click', async e => {
  const btn = e.target.closest('button[data-url][data-name]');
  if (!btn) return;
  const url  = decodeURIComponent(btn.dataset.url);
  const name = decodeURIComponent(btn.dataset.name);
  const accountId = btn.dataset.accountId || '';
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = '…';
  try {
    await chrome.downloads.download({ url, filename: name, saveAs: false });
    btn.textContent = '✓ Начато';
    // Remove from readyFiles
    const { readyFiles = [] } = await new Promise(r => chrome.storage.local.get('readyFiles', r));
    await new Promise(r => chrome.storage.local.set({ readyFiles: readyFiles.filter(f => !(f.name === name && (!accountId || !f.accountId || f.accountId === accountId))) }, r));
    const card = document.getElementById('ri-' + encodeURIComponent(name));
    if (card) card.remove();
    if ($('ready-list') && !$('ready-list').children.length) $('ready-section').style.display = 'none';
  } catch (e) {
    chrome.tabs.create({ url });
    btn.textContent = '↗ Открыто';
  }
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 3000);
});

$('refresh-btn').addEventListener('click', () => { clearTimeout(pollTimer); loadDownloadsTab(); });
$('manual-url-btn').addEventListener('click', addManualUrlDownload);
$('manual-url-inp').addEventListener('keydown', e => { if (e.key === 'Enter') addManualUrlDownload(); });
$('manual-name-inp').addEventListener('keydown', e => { if (e.key === 'Enter') addManualUrlDownload(); });
window.addEventListener('unload', () => clearTimeout(pollTimer));
