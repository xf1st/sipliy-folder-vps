// Sipliy Folder VPS — popup script v2.3

const $ = id => document.getElementById(id);

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

// ─── Settings tab ─────────────────────────────────────────
const urlEl   = $('serverUrl');
const tokenEl = $('token');
const toast   = $('toast');
const autoDl  = $('auto-dl');

function setStatus(level, title, sub) {
  $('status-dot').className = 'dot ' + level;
  $('status-title').textContent = title;
  $('status-sub').textContent = sub;
}
function setToast(level, msg) { toast.className = 'toast ' + level; toast.textContent = msg; }
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function normalizeUrl(u) {
  u = (u || '').trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

// Загрузка настроек + автопереход на вкладку Загрузки
chrome.storage.sync.get(['serverUrl', 'token'], cfg => {
  if (cfg.serverUrl) urlEl.value = cfg.serverUrl;
  if (cfg.token)     tokenEl.value = cfg.token;
  refreshStatus();
  // Если расширение настроено — сразу открыть вкладку Загрузки
  if (cfg.serverUrl && cfg.token) {
    switchTab('downloads');
  }
});
chrome.storage.local.get('autoDownload', d => {
  autoDl.checked = d.autoDownload !== false;
});

async function refreshStatus() {
  const url = normalizeUrl(urlEl.value), token = (tokenEl.value || '').trim();
  if (!url || !token) { setStatus('warn', 'Не настроено', 'Введите URL и токен'); return; }
  setStatus('warn', 'Проверка…', url);
  const r = await testConn(url, token);
  r.ok ? setStatus('ok', 'Подключено', url) : setStatus('err', 'Ошибка: ' + r.error, url);
}

async function testConn(url, token) {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url + '/api/add-ext', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'url=', signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'Неверный токен' };
    if (res.status === 400 || res.ok) return { ok: true };
    return { ok: false, error: 'HTTP ' + res.status };
  } catch (e) { return { ok: false, error: e.name === 'AbortError' ? 'Таймаут' : e.message }; }
}

$('eye').addEventListener('click', () => { tokenEl.type = tokenEl.type === 'password' ? 'text' : 'password'; });

$('test-btn').addEventListener('click', async () => {
  const url = normalizeUrl(urlEl.value), token = (tokenEl.value || '').trim();
  if (!url || !token) { setToast('err', 'Введите URL и токен'); return; }
  $('test-btn').disabled = true; setToast('info', 'Проверяем…');
  const r = await testConn(url, token);
  $('test-btn').disabled = false;
  r.ok ? (setToast('ok', '✓ Соединение работает'), setStatus('ok', 'Подключено', url))
       : (setToast('err', '✕ ' + r.error), setStatus('err', 'Ошибка', r.error));
});

$('save-btn').addEventListener('click', () => {
  const url = normalizeUrl(urlEl.value), token = (tokenEl.value || '').trim();
  if (!url || !token) { setToast('err', 'Заполните оба поля'); return; }
  chrome.storage.sync.set({ serverUrl: url, token }, () => {
    urlEl.value = url;
    setToast('ok', '✓ Сохранено!');
    refreshStatus();
    setTimeout(() => setToast('info', ''), 2500);
  });
});

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
      errorType = null;
    } catch (e) { errorMsg = e.message || ''; errorType = 'blocked'; }
  }

  if (!errorType) {
    warn.style.display = 'none';
    setToast('ok', '✓ Авто-скачивание работает!');
  } else {
    warn.style.display = 'flex';
    const isEdge = navigator.userAgent.includes('Edg/');
    const browserName = isEdge ? 'Edge' : 'Chrome';
    if (errorType === 'no-permission') {
      inst.innerHTML = `<b>Причина:</b> расширению не выдано разрешение на загрузку файлов.<br>
        <b>Решение — перезагрузить расширение:</b>
        <ol><li>Откройте <b>${isEdge ? 'edge' : 'chrome'}://extensions</b></li>
        <li>Найдите <b>Sipliy Folder VPS</b></li>
        <li>Нажмите кнопку <b>↻ обновить</b></li>
        <li>Снова нажмите «Тест авто-загрузки»</li></ol>`;
    } else {
      inst.innerHTML = `<b>Причина:</b> браузер заблокировал автоматическую загрузку.<br>
        <b>Решение:</b>
        <ol><li>Откройте настройки ${browserName}: <b>⋯</b> → <b>Настройки</b></li>
        <li>Перейдите в <b>Конфиденциальность и безопасность</b></li>
        <li>Откройте <b>Настройки сайтов</b></li>
        <li>Найдите <b>Автоматическая загрузка файлов</b></li>
        <li>Добавьте <b>${normalizeUrl(urlEl.value) || 'адрес вашего сервера'}</b> в список разрешённых</li>
        <li>Снова нажмите «Тест авто-загрузки»</li></ol>
        ${errorMsg ? '<span style="font-size:.67rem;color:#92400e;margin-top:4px;display:block">Ошибка: ' + escHtml(errorMsg) + '</span>' : ''}`;
    }
    setToast('err', '✕ Авто-скачивание заблокировано');
  }

  btn.textContent = 'Тест авто-загрузки';
  setTimeout(() => { btn.disabled = false; }, 1500);
});

autoDl.addEventListener('change', () => chrome.storage.local.set({ autoDownload: autoDl.checked }));
$('open-site').addEventListener('click', e => { e.preventDefault(); chrome.tabs.create({ url: normalizeUrl(urlEl.value) || 'https://sipliyfolder.ru' }); });
$('open-help').addEventListener('click', e => { e.preventDefault(); chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') }); });
[urlEl, tokenEl].forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') $('save-btn').click(); }));

// ─── Downloads tab ────────────────────────────────────────
let pollTimer = null;

function getConfig() {
  return new Promise(r => chrome.storage.sync.get(['serverUrl', 'token'], cfg =>
    r({ serverUrl: (cfg.serverUrl || '').replace(/\/+$/, ''), token: cfg.token || '' })
  ));
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
const SL = { active:'Скачивается', waiting:'В очереди', paused:'Пауза', complete:'Готово', error:'Ошибка' };

async function loadDownloadsTab() {
  clearTimeout(pollTimer);
  await renderDownloads();
  pollTimer = setTimeout(loadDownloadsTab, 2000); // обновляем каждые 2 секунды
}

async function renderDownloads() {
  const cfg = await getConfig();
  if (!cfg.serverUrl || !cfg.token) {
    $('ready-section').style.display = 'none';
    $('active-list').innerHTML = '<div class="empty-state"><div class="icon">⚙️</div>Сначала настройте расширение</div>';
    $('file-list').innerHTML = '';
    return;
  }

  // Параллельно запрашиваем загрузки и файлы
  const [dlRes, filesRes] = await Promise.all([
    fetch(cfg.serverUrl + '/api/downloads-ext', { headers: { 'Authorization': 'Bearer ' + cfg.token } }).catch(() => null),
    fetch(cfg.serverUrl + '/api/files-ext',     { headers: { 'Authorization': 'Bearer ' + cfg.token } }).catch(() => null),
  ]);

  // Получаем текущие файлы на VPS
  let vpsFiles = [];
  if (filesRes && filesRes.ok) {
    vpsFiles = await filesRes.json().catch(() => []);
  }
  const vpsFileNames = new Set(vpsFiles.map(f => f.name));

  // ── Чистим readyFiles: удаляем те, которых больше нет на VPS ──
  const { readyFiles: rawReady = [] } = await new Promise(r => chrome.storage.local.get('readyFiles', r));
  const readyFiles = rawReady.filter(f => vpsFileNames.has(f.name));
  if (readyFiles.length !== rawReady.length) {
    await new Promise(r => chrome.storage.local.set({ readyFiles }, r));
  }

  // ── Секция "Готово — скачать на ПК" ──
  const readySection = $('ready-section');
  const readyList    = $('ready-list');
  if (readyFiles.length > 0) {
    readySection.style.display = 'block';
    readyList.innerHTML = readyFiles.map(f => `
      <div class="ready-item" id="ready-${encodeURIComponent(f.name)}">
        <div class="ready-icon">${fileEmoji(f.name)}</div>
        <div class="ready-info">
          <div class="ready-name" title="${escHtml(f.name)}">${escHtml(f.name)}</div>
          <div class="ready-meta">${fmt(f.size)} · готово ${fmtDate(f.readyAt)}</div>
        </div>
        <button class="btn-pc" data-url="${encodeURIComponent(f.dlUrl)}" data-name="${encodeURIComponent(f.name)}" onclick="doDownload(this)">⬇ На ПК</button>
      </div>`).join('');
  } else {
    readySection.style.display = 'none';
  }

  // ── Активные загрузки VPS ──
  const activeEl = $('active-list');
  if (!dlRes || !dlRes.ok) {
    activeEl.innerHTML = '<div class="empty-state"><div class="icon">⚠️</div>Нет соединения с сервером</div>';
  } else {
    const dls = await dlRes.json().catch(() => []);
    const ongoing = dls.filter(d => d.status !== 'complete');
    const countEl = $('dl-count');
    ongoing.length > 0 ? (countEl.textContent = ongoing.length, countEl.classList.add('show')) : countEl.classList.remove('show');
    if (!ongoing.length) {
      activeEl.innerHTML = '<div class="empty-state"><div class="icon">🎯</div>Нет активных загрузок</div>';
    } else {
      activeEl.innerHTML = ongoing.map(d => {
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
      }).join('');
    }
  }

  // ── Все файлы на VPS ──
  const fileEl = $('file-list');
  if (!filesRes || !filesRes.ok) {
    fileEl.innerHTML = '<div class="empty-state"><div class="icon">⚠️</div>Нет соединения с сервером</div>';
    return;
  }
  if (!vpsFiles.length) {
    fileEl.innerHTML = '<div class="empty-state"><div class="icon">📂</div>Файлов нет</div>';
  } else {
    const token = cfg.token, server = cfg.serverUrl;
    fileEl.innerHTML = vpsFiles.map(f => {
      const dlUrl = server + '/api/ext-dl/' + encodeURIComponent(f.name) + '?t=' + encodeURIComponent(token);
      return `<div class="file-item">
        <div class="file-ico">${fileEmoji(f.name)}</div>
        <div class="file-info">
          <div class="file-name" title="${escHtml(f.name)}">${escHtml(f.name)}</div>
          <div class="file-meta">${fmt(f.size)} · ${fmtDate(new Date(f.mtime).getTime())}</div>
        </div>
        <button class="btn-sm btn-dl" data-url="${encodeURIComponent(dlUrl)}" data-name="${encodeURIComponent(f.name)}" onclick="doDownload(this)">⬇ На ПК</button>
      </div>`;
    }).join('');
  }
}

async function doDownload(btn) {
  const url  = decodeURIComponent(btn.dataset.url);
  const name = decodeURIComponent(btn.dataset.name);
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = '…';
  try {
    await chrome.downloads.download({ url, filename: name, saveAs: false });
    btn.textContent = '✓ Начато';
    // Убрать из readyFiles
    const { readyFiles = [] } = await new Promise(r => chrome.storage.local.get('readyFiles', r));
    await new Promise(r => chrome.storage.local.set({ readyFiles: readyFiles.filter(f => f.name !== name) }, r));
    const card = $('ready-' + encodeURIComponent(name));
    if (card) card.remove();
    if ($('ready-list') && $('ready-list').children.length === 0) $('ready-section').style.display = 'none';
  } catch (e) {
    chrome.tabs.create({ url });
    btn.textContent = '↗ Открыто';
  }
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 3000);
}

$('refresh-btn').addEventListener('click', () => { clearTimeout(pollTimer); loadDownloadsTab(); });
window.addEventListener('unload', () => clearTimeout(pollTimer));
