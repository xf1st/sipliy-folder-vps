// Sipliy Folder VPS — popup script v2.10 (theme sync)

const $ = id => document.getElementById(id);

// ─── Utilities ────────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function normalizeUrl(u) {
  u = (u || '').trim().replace(/\/+$/, '');
  if (!u) return u;
  const noScheme = u.replace(/^https?:\/\//i, '');
  if (/^http:\/\//i.test(u) && /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(noScheme)) return u;
  return 'https://' + noScheme;
}
function safeFilename(name) {
  let n = String(name || '').split(/[\\/]/).pop() || '';
  n = n.replace(/^[.\s]+/, '');
  n = n.replace(/[<>:"|?*\x00-\x1f]/g, '_');
  if (n.length > 200) n = n.slice(0, 200);
  return n || 'download.bin';
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
  if (tabName === 'files') loadFilesTab();
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
  // Sync accent color from active account
  const acc = getActiveAccount(accounts, activeAccountId);
  if (acc && siteUrl && acc.token) {
    fetch(siteUrl + '/api/ext/theme', { headers: { 'Authorization': 'Bearer ' + acc.token } })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d && d.accentHex && typeof applyExtAccent === 'function') applyExtAccent(d.accentHex); })
      .catch(() => {});
  }
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

// Клик по любой ссылке в попапе
document.addEventListener('click', e => {
  const a = e.target.closest('a');
  if (a && a.getAttribute('href') !== '#') {
    // Если есть реальная ссылка
    return; 
  }
  if (a && (a.id === 'open-site-form' || a.id === 'open-help' || a.classList.contains('site-link'))) {
    e.preventDefault();
    const urlInp = $('site-url-inp');
    const url = normalizeUrl(urlInp ? urlInp.value : '') || 'https://sipliyfolder.ru';
    chrome.tabs.create({ url: a.id === 'open-help' ? chrome.runtime.getURL('welcome.html') : url });
  }
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
    if ($('file-list')) $('file-list').innerHTML = '';
    if ($('upload-file-list')) $('upload-file-list').innerHTML = '';
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
    $('ready-list').innerHTML = readyFiles.map(f => {
      const filePath = f.path || ('/' + f.name);
      return `<div class="ready-item" id="ri-${escHtml(encodeURIComponent(f.name))}">
        <div class="ready-icon">${fileEmoji(f.name)}</div>
        <div class="ready-info">
          <div class="ready-name" title="${escHtml(f.name)}">${escHtml(f.name)}</div>
          <div class="ready-meta">${fmt(f.size)} · готово ${fmtDate(f.readyAt)}</div>
        </div>
        <button class="btn-sm btn-share" style="flex-shrink:0;margin-right:4px" data-share-file="${escHtml(f.name)}" data-share-path="${escHtml(filePath)}" title="Публичная ссылка / QR">🔗</button>
        <button class="btn-pc" data-name="${escHtml(encodeURIComponent(f.name))}" data-account-id="${escHtml(f.accountId || activeAcc?.id || '')}">⬇ На ПК</button>
      </div>`;
    }).join('');
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
    const errorCount = ongoing.filter(d => d.status === 'error').length;
    const countEl = $('dl-count');
    const activeCount = ongoing.filter(d => d.status === 'active' || d.status === 'waiting').length;
    activeCount > 0
      ? (countEl.textContent = activeCount, countEl.classList.add('show'))
      : countEl.classList.remove('show');

    // Кнопка очистки ошибок
    const purgeBtn = $('purge-errors-btn');
    if (purgeBtn) purgeBtn.style.display = errorCount > 0 ? '' : 'none';

    activeEl.innerHTML = ongoing.length
      ? ongoing.map(d => {
          const speed = d.speed ? ' · ' + fmt(d.speed) + '/с' : '';
          const displayName = d.name || (d.status === 'error' ? '(без имени)' : '...');
          return `<div class="dl-item">
            <div class="dl-top">
              <div style="min-width:0;flex:1">
                <div class="dl-name" title="${escHtml(displayName)}">${escHtml(displayName)}</div>
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
  const uploadFileEl = $('upload-file-list');
  if (!filesRes || !filesRes.ok) {
    if (fileEl) fileEl.innerHTML = '<div class="empty-state"><div class="icon">⚠️</div>Нет соединения с сервером</div>';
    if (uploadFileEl) uploadFileEl.innerHTML = '<div class="empty-state"><div class="icon">⚠️</div>Нет соединения с сервером</div>';
    return;
  }

  const downloadFiles = vpsFiles.filter(f => f.source !== 'upload');
  const uploadFiles = vpsFiles.filter(f => f.source === 'upload');

  const renderSingleList = (files) => {
    return files.map(f => {
      const filePath = f.path || ('/' + f.name);
      return `<div class="file-item">
        <div class="file-ico">${fileEmoji(f.name)}</div>
        <div class="file-info">
          <div class="file-name" title="${escHtml(f.name)}">${escHtml(f.name)}</div>
          <div class="file-meta">${fmt(f.size)} · ${fmtDate(new Date(f.mtime).getTime())}</div>
        </div>
        <button class="btn-sm btn-share" data-share-file="${escHtml(f.name)}" data-share-path="${escHtml(filePath)}" title="Публичная ссылка / QR">🔗</button>
        <button class="btn-sm btn-dl" data-name="${escHtml(encodeURIComponent(f.name))}">⬇</button>
      </div>`;
    }).join('');
  };

  if (fileEl) {
    fileEl.innerHTML = downloadFiles.length
      ? renderSingleList(downloadFiles)
      : '<div class="empty-state"><div class="icon">📂</div>Файлов нет</div>';
  }

  if (uploadFileEl) {
    uploadFileEl.innerHTML = uploadFiles.length
      ? renderSingleList(uploadFiles)
      : '<div class="empty-state"><div class="icon">📂</div>Файлов нет</div>';
  }
}

// ─── URL mode selector ───────────────────────────────────────────
let _currentUrlMode = 'file';

function selectUrlMode(mode) {
  _currentUrlMode = mode;
  ['file', 'video', 'audio', 'best'].forEach(m => {
    const card = $('url-card-' + m);
    if (card) card.classList.toggle('selected', m === mode);
  });
  const sel = $('url-mode-inp');
  if (sel) sel.value = mode;
  const nameInp = $('manual-name-inp');
  if (nameInp) {
    nameInp.placeholder = mode === 'file'
      ? 'Имя файла (необязательно)'
      : 'Название без расширения (необязательно)';
  }
}

// Mode card clicks (CSP-safe, no inline handlers)
document.addEventListener('click', e => {
  const card = e.target.closest('[data-url-mode]');
  if (card) { selectUrlMode(card.dataset.urlMode); }
});

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

async function addManualUrlDirect(cfg, url, filename) {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 12000);
  const body = new URLSearchParams();
  body.set('url', url);
  if (filename) body.set('filename', filename);

  const res = await fetch(cfg.serverUrl + '/api/add-ext', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + cfg.token,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString(),
    signal: ctrl.signal
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));

  const name = filename || guessUrlName(url);
  const { pendingGids = {} } = await new Promise(r => chrome.storage.local.get('pendingGids', r));
  pendingGids[data.gid] = { gid: data.gid, name, origName: name, status: 'active', addedAt: Date.now(), progress: 0, accountId: cfg.accountId, forceAutoDownload: true };
  await new Promise(r => chrome.storage.local.set({ pendingGids }, r));
  return { gid: data.gid, name };
}

async function addManualUrlDownload() {
  const cfg = await getConfig();
  const btn = $('manual-url-btn');
  const url = $('manual-url-inp').value.trim();
  const filename = $('manual-name-inp').value.trim();
  const mode = _currentUrlMode || 'file';

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

  // ── Media mode (yt-dlp) — прямой fetch, без SW ──────────
  if (mode !== 'file') {
    setManualUrlStatus('', 'Запускаю...');
    try {
      const ctrl = new AbortController();
      const abortTimer = setTimeout(() => ctrl.abort(), 15000);
      const body = new URLSearchParams({ url, mode });
      if (filename) body.set('filename', filename);
      let res, data;
      try {
        res = await fetch(cfg.serverUrl + '/api/ext/media', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + cfg.token, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          signal: ctrl.signal,
        });
        clearTimeout(abortTimer);
        data = await res.json().catch(() => ({}));
      } catch (fetchErr) {
        clearTimeout(abortTimer);
        throw fetchErr;
      }
      if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
      $('manual-url-inp').value = '';
      $('manual-name-inp').value = '';
      setManualUrlStatus('ok', 'Запущено! Файл появится когда скачается');
      // Будим SW чтобы обновил файлы раньше
      try { chrome.runtime.sendMessage({ type: 'sync-files' }); } catch(_) {}
    } catch (e) {
      const msg = e.name === 'AbortError' ? 'Сервер не ответил (15с)' : (e.message || 'Ошибка соединения');
      setManualUrlStatus('err', msg);
    } finally {
      setTimeout(() => { btn.disabled = false; }, 700);
    }
    return;
  }

  // ── File mode (aria2) ────────────────────────────────
  setManualUrlStatus('', 'Отправляю...');
  try {
    let data;
    try {
      data = await chrome.runtime.sendMessage({ type: 'add-url-download', url, filename });
      if (!data || !data.ok) throw new Error((data && data.error) || 'Ошибка');
    } catch (msgErr) {
      if (!/Receiving end does not exist|Could not establish connection/i.test(msgErr.message || '')) throw msgErr;
      data = await addManualUrlDirect(cfg, url, filename);
    }

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

function setCaptureStatus(kind, text) {
  const el = $('capture-status');
  if (!el) return;
  el.className = 'url-status ' + (kind || '');
  el.textContent = text || '';
}

async function refreshCaptureStatus() {
  const btn = $('capture-next-btn');
  const relay = $('capture-relay-btn');
  const cancel = $('capture-cancel-btn');
  if (!btn || !cancel) return;
  // Читаем напрямую из storage — не зависим от того, работает ли SW
  const { captureNext = null } = await new Promise(r => chrome.storage.local.get('captureNext', r));
  const c = captureNext;
  if (c && c.active && Date.now() < c.expiresAt) {
    btn.disabled = true;
    if (relay) relay.disabled = true;
    cancel.style.display = '';
    const sec = Math.max(0, Math.ceil((c.expiresAt - Date.now()) / 1000));
    setCaptureStatus('', (c.mode === 'relay' ? 'Браузер: ' : 'VPS: ') + sec + 'с');
  } else {
    btn.disabled = false;
    if (relay) relay.disabled = false;
    cancel.style.display = 'none';
    setCaptureStatus('', '');
  }
}

async function startCaptureNextDownload(mode = 'direct') {
  const btn = $('capture-next-btn');
  const relayBtn = $('capture-relay-btn');
  if (btn) btn.disabled = true;
  if (relayBtn) relayBtn.disabled = true;
  setCaptureStatus('', 'Включаю...');
  try {
    let data;
    try {
      data = await chrome.runtime.sendMessage({ type: 'capture-next-download', timeoutMs: 90000, mode });
    } catch (_) {
      data = null; // SW спит — перейдём к fallback
    }
    if (data && !data.ok) throw new Error(data.error || 'Ошибка');
    if (!data || !data.captureNext) {
      // Fallback: SW не ответил — пишем состояние напрямую в storage
      const cfg = await getConfig();
      if (!cfg.serverUrl || !cfg.token) throw new Error('Добавьте аккаунт');
      const captureNext = {
        active: true, accountId: cfg.accountId, serverUrl: cfg.serverUrl,
        mode: mode === 'relay' ? 'relay' : 'direct',
        startedAt: Date.now(), expiresAt: Date.now() + 90000,
      };
      await new Promise(r => chrome.storage.local.set({ captureNext }, r));
    }
    setCaptureStatus('ok', mode === 'relay' ? 'Кликни Download: браузер загрузит на VPS' : 'Теперь нажми Download на странице');
    refreshCaptureStatus();
  } catch (e) {
    if (btn) btn.disabled = false;
    if (relayBtn) relayBtn.disabled = false;
    setCaptureStatus('err', e.message || 'Ошибка');
  }
}

async function cancelCaptureNextDownload() {
  // Пишем отмену напрямую в storage + уведомляем SW если он жив
  const { captureNext = null } = await new Promise(r => chrome.storage.local.get('captureNext', r));
  if (captureNext) {
    await new Promise(r => chrome.storage.local.set({ captureNext: { ...captureNext, active: false, reason: 'cancelled' } }, r));
  }
  try { chrome.runtime.sendMessage({ type: 'cancel-download-capture' }); } catch (_) {}
  setCaptureStatus('', '');
  refreshCaptureStatus();
}

// ─── Ticket helper (одноразовый URL для chrome.downloads) ─
async function fetchTicketUrl(cfg, fileName) {
  const res = await fetch(cfg.serverUrl + '/api/ext-ticket', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + cfg.token, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'file=' + encodeURIComponent(fileName),
  });
  if (!res.ok) throw new Error('ticket HTTP ' + res.status);
  const d = await res.json();
  if (!d.url) throw new Error('ticket missing url');
  return cfg.serverUrl + d.url;
}

// ─── Download button handler (event delegation, CSP-safe) ─
document.addEventListener('click', async e => {
  const btn = e.target.closest('button.btn-dl[data-name], button.btn-pc[data-name]');
  if (!btn) return;
  const name = decodeURIComponent(btn.dataset.name);
  const accountId = btn.dataset.accountId || '';
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = '…';
  let openedUrl = '';
  try {
    const cfg = await getConfig();
    if (!cfg.serverUrl || !cfg.token) throw new Error('Аккаунт не настроен');
    const url = await fetchTicketUrl(cfg, name);
    openedUrl = url;
    await chrome.downloads.download({ url, filename: safeFilename(name), saveAs: false });
    btn.textContent = '✓ Начато';
    const { readyFiles = [] } = await new Promise(r => chrome.storage.local.get('readyFiles', r));
    await new Promise(r => chrome.storage.local.set({ readyFiles: readyFiles.filter(f => !(f.name === name && (!accountId || !f.accountId || f.accountId === accountId))) }, r));
    const card = document.getElementById('ri-' + encodeURIComponent(name));
    if (card) card.remove();
    if ($('ready-list') && !$('ready-list').children.length) $('ready-section').style.display = 'none';
  } catch (e) {
    if (openedUrl) chrome.tabs.create({ url: openedUrl });
    btn.textContent = '✕ Ошибка';
  }
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 3000);
});

$('refresh-btn').addEventListener('click', () => { clearTimeout(pollTimer); loadDownloadsTab(); });
$('purge-errors-btn').addEventListener('click', async () => {
  const btn = $('purge-errors-btn');
  btn.disabled = true; btn.textContent = '⏳ Очищаю...';
  try {
    const cfg = await getConfig();
    await fetch(cfg.serverUrl + '/api/purge-errors-ext', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + cfg.token }
    });
  } catch (_) {}
  clearTimeout(pollTimer);
  loadDownloadsTab();
});
$('manual-url-btn').addEventListener('click', addManualUrlDownload);
$('manual-url-inp').addEventListener('keydown', e => { if (e.key === 'Enter') addManualUrlDownload(); });
$('manual-name-inp').addEventListener('keydown', e => { if (e.key === 'Enter') addManualUrlDownload(); });
$('capture-next-btn')?.addEventListener('click', () => startCaptureNextDownload('direct'));
$('capture-relay-btn')?.addEventListener('click', () => startCaptureNextDownload('relay'));
$('capture-cancel-btn')?.addEventListener('click', cancelCaptureNextDownload);
refreshCaptureStatus();
setInterval(refreshCaptureStatus, 1000);
window.addEventListener('unload', () => clearTimeout(pollTimer));

// ─── QR / Share modal ─────────────────────────────────────
let _qrFilePath = null, _qrFileName = null, _qrCfg = null;

function qrImgUrl(link) {
  return 'https://api.qrserver.com/v1/create-qr-code/?size=160x160&qzone=1&format=svg&data=' + encodeURIComponent(link);
}

function renderQrLinks(links) {
  const wrap = $('qr-links-wrap');
  if (!links.length) {
    wrap.innerHTML = '<div style="text-align:center;color:var(--muted);font-size:.78rem;padding:10px 0">Публичных ссылок нет.<br>Нажмите кнопку ниже чтобы создать.</div>';
    return;
  }
  wrap.innerHTML = links.map((lnk, i) => `
    <div class="qr-link-row">
      <div class="qr-link-url">${escHtml(lnk.fullUrl)}</div>
      <div class="qr-img-wrap"><img src="${escHtml(qrImgUrl(lnk.fullUrl))}" alt="QR" loading="lazy"/></div>
      <div class="qr-actions">
        <button class="btn btn-secondary" style="flex:1;font-size:.71rem;padding:6px 8px" data-copy-link="${escHtml(lnk.fullUrl)}">📋 Копировать</button>
        <button class="btn btn-secondary" style="flex:1;font-size:.71rem;padding:6px 8px" data-open-link="${escHtml(lnk.fullUrl)}">↗ Открыть</button>
      </div>
    </div>`).join('');
}

async function openShareModal(fileName, filePath) {
  const cfg = await getConfig();
  if (!cfg.serverUrl || !cfg.token) return;
  _qrFilePath = filePath;
  _qrFileName = fileName;
  _qrCfg = cfg;

  $('qr-filename').textContent = fileName;
  $('qr-links-wrap').innerHTML = '<div style="text-align:center;padding:16px;color:var(--muted);font-size:.8rem">Загрузка ссылок...</div>';
  $('qr-status').textContent = '';
  $('qr-status').className = 'qr-status';
  $('qr-overlay').style.display = 'flex';

  try {
    const r = await fetch(cfg.serverUrl + '/api/ext/shares?path=' + encodeURIComponent(filePath), {
      headers: { 'Authorization': 'Bearer ' + cfg.token }
    });
    const d = await r.json();
    renderQrLinks(d.links || []);
  } catch (e) {
    $('qr-links-wrap').innerHTML = '<div style="color:var(--err);font-size:.78rem;text-align:center">Ошибка загрузки ссылок</div>';
  }
}

function closeShareModal() {
  $('qr-overlay').style.display = 'none';
  _qrFilePath = null; _qrFileName = null; _qrCfg = null;
}

$('qr-close-btn').addEventListener('click', closeShareModal);
$('qr-overlay').addEventListener('click', e => { if (e.target === $('qr-overlay')) closeShareModal(); });

$('qr-create-btn').addEventListener('click', async () => {
  if (!_qrFilePath || !_qrCfg) return;
  const btn = $('qr-create-btn');
  btn.disabled = true; btn.textContent = '⏳ Создаю...';
  $('qr-status').textContent = ''; $('qr-status').className = 'qr-status';
  try {
    const r = await fetch(_qrCfg.serverUrl + '/api/ext/share', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + _qrCfg.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: _qrFilePath })
    });
    const d = await r.json();
    if (d.ok) {
      $('qr-status').textContent = '✓ Ссылка создана'; $('qr-status').className = 'qr-status ok';
      // Reload links
      const r2 = await fetch(_qrCfg.serverUrl + '/api/ext/shares?path=' + encodeURIComponent(_qrFilePath), {
        headers: { 'Authorization': 'Bearer ' + _qrCfg.token }
      });
      const d2 = await r2.json();
      renderQrLinks(d2.links || []);
    } else {
      $('qr-status').textContent = d.error || 'Ошибка'; $('qr-status').className = 'qr-status err';
    }
  } catch {
    $('qr-status').textContent = 'Ошибка запроса'; $('qr-status').className = 'qr-status err';
  }
  btn.disabled = false; btn.textContent = '🔗 Создать публичную ссылку';
});

// Event delegation for copy/open inside modal
$('qr-links-wrap').addEventListener('click', e => {
  const copyBtn = e.target.closest('[data-copy-link]');
  if (copyBtn) {
    navigator.clipboard.writeText(copyBtn.dataset.copyLink).then(() => {
      const orig = copyBtn.textContent;
      copyBtn.textContent = '✓ Скопировано';
      setTimeout(() => { copyBtn.textContent = orig; }, 1800);
    });
    return;
  }
  const openBtn = e.target.closest('[data-open-link]');
  if (openBtn) { chrome.tabs.create({ url: openBtn.dataset.openLink }); return; }
});

// Share button clicks in file list (event delegation)
document.addEventListener('click', e => {
  const shareBtn = e.target.closest('[data-share-file]');
  if (!shareBtn) return;
  openShareModal(shareBtn.dataset.shareFile, shareBtn.dataset.sharePath);
});

// ─── File Browser (tab "Файлы") ───────────────────────────
let fbCurrentPath = '';

async function loadFilesTab() {
  await browseFolder('');
}

async function browseFolder(relPath) {
  fbCurrentPath = relPath;
  const cfg = await getConfig();
  const entriesEl = $('fb-entries');
  const crumbEl = $('fb-breadcrumb');

  // Breadcrumb
  if (crumbEl) {
    const parts = relPath ? relPath.split('/').filter(Boolean) : [];
    let html = '<button class="fb-crumb" data-fb-path="">🏠 Корень</button>';
    let builtPath = '';
    parts.forEach((part, i) => {
      builtPath = builtPath ? builtPath + '/' + part : part;
      const isLast = i === parts.length - 1;
      html += '<span class="fb-sep">›</span>';
      html += `<button class="fb-crumb${isLast ? ' active' : ''}" data-fb-path="${escHtml(builtPath)}">${escHtml(part)}</button>`;
    });
    crumbEl.innerHTML = html;
  }

  if (!cfg.serverUrl || !cfg.token) {
    if (entriesEl) entriesEl.innerHTML = '<div class="empty-state"><div class="icon">⚙️</div>Добавьте аккаунт</div>';
    return;
  }

  if (entriesEl) entriesEl.innerHTML = '<div class="empty-state"><div class="icon" style="font-size:1.5rem">⏳</div>Загрузка...</div>';

  try {
    const r = await fetch(cfg.serverUrl + '/api/ext/browse?path=' + encodeURIComponent(relPath), {
      headers: { 'Authorization': 'Bearer ' + cfg.token }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || 'Ошибка');
    const entries = d.entries || [];

    if (!entries.length) {
      if (entriesEl) entriesEl.innerHTML = '<div class="empty-state"><div class="icon">📂</div>Папка пустая</div>';
      return;
    }

    if (entriesEl) {
      entriesEl.innerHTML = entries.map(e => {
        const ico = e.isDir ? '📁' : fileEmoji(e.name);
        const meta = e.isDir ? 'Папка' : (fmt(e.size) + ' · ' + fmtDate(new Date(e.mtime).getTime()));
        const entryRelPath = relPath ? (relPath + '/' + e.name) : e.name;
        const sharePathStr = '/' + entryRelPath;
        if (e.isDir) {
          return `<div class="fb-entry is-dir" data-fb-folder="${escHtml(entryRelPath)}">
            <div class="fb-ico">${ico}</div>
            <div class="fb-info">
              <div class="fb-name">${escHtml(e.name)}</div>
              <div class="fb-meta">${meta}</div>
            </div>
            <span style="color:var(--muted);font-size:.85rem;flex-shrink:0">›</span>
          </div>`;
        } else {
          return `<div class="fb-entry">
            <div class="fb-ico">${ico}</div>
            <div class="fb-info">
              <div class="fb-name" title="${escHtml(e.name)}">${escHtml(e.name)}</div>
              <div class="fb-meta">${meta}</div>
            </div>
            <button class="btn-sm btn-share" data-share-file="${escHtml(e.name)}" data-share-path="${escHtml(sharePathStr)}" title="Публичная ссылка">🔗</button>
            <button class="btn-sm btn-dl" data-name="${escHtml(encodeURIComponent(e.name))}">⬇</button>
          </div>`;
        }
      }).join('');
    }
  } catch (e) {
    if (entriesEl) entriesEl.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div>${escHtml(e.message || 'Ошибка')}</div>`;
  }
}

// File browser: breadcrumb + folder click navigation
document.addEventListener('click', e => {
  // Breadcrumb nav
  const crumb = e.target.closest('button.fb-crumb[data-fb-path]');
  if (crumb && !crumb.classList.contains('active')) {
    browseFolder(crumb.dataset.fbPath);
    return;
  }
  // Folder open
  const folderEntry = e.target.closest('[data-fb-folder]');
  if (folderEntry) {
    browseFolder(folderEntry.dataset.fbFolder);
    return;
  }
});

// ─── OTA version check ────────────────────────────────────
const CURRENT_VERSION = chrome.runtime.getManifest().version;
{
  const vEl = $('ext-version');
  if (vEl) vEl.textContent = CURRENT_VERSION;
}

function versionNewer(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i]||0) < (pb[i]||0)) return true;
    if ((pa[i]||0) > (pb[i]||0)) return false;
  }
  return false;
}

async function checkForUpdate(showStatus = false) {
  try {
    const { siteUrl } = await loadAccountsData();
    if (!siteUrl) return;
    const r = await fetch(siteUrl + '/api/ext/version');
    const d = await r.json();
    if (versionNewer(CURRENT_VERSION, d.version)) {
      $('update-badge').style.display = '';
      $('check-update-btn').classList.add('has-update');
      $('check-update-btn').title = 'Доступна версия v' + d.version;
      chrome.storage.local.set({ pendingUpdate: d });
      if (showStatus) {
        chrome.tabs.create({ url: d.downloadUrl });
      }
    } else {
      $('update-badge').style.display = 'none';
      $('check-update-btn').classList.remove('has-update');
      chrome.storage.local.remove('pendingUpdate');
      if (showStatus) {
        const orig = $('check-update-btn').textContent;
        $('check-update-btn').textContent = '✓ Актуальная';
        setTimeout(() => { $('check-update-btn').textContent = orig; }, 2000);
      }
    }
  } catch { /* silently ignore network errors */ }
}

$('check-update-btn').addEventListener('click', async () => {
  const btn = $('check-update-btn');
  // If update already known — open download page directly
  const { pendingUpdate } = await new Promise(r => chrome.storage.local.get('pendingUpdate', r));
  if (pendingUpdate) { chrome.tabs.create({ url: pendingUpdate.downloadUrl }); return; }
  btn.textContent = '⏳';
  await checkForUpdate(true);
  setTimeout(() => { if (btn.textContent === '⏳') btn.textContent = '🔄'; }, 2100);
});

// Check on popup open (silently)
checkForUpdate(false);
