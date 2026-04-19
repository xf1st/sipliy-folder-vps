// Sipliy Folder VPS — background service worker v2.2

const ICON = 'icons/icon-128.png';
const POLL_ALARM = 'poll-vps';

// ─── Инициализация ────────────────────────────────────────
chrome.runtime.onInstalled.addListener((details) => {
  setupContextMenus();
  setupAlarm();
  refreshBadge();
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  }
});
chrome.runtime.onStartup.addListener(() => {
  setupContextMenus();
  setupAlarm();
  refreshBadge();
});

function setupAlarm() {
  chrome.alarms.get(POLL_ALARM, a => {
    if (!a) chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.25 }); // каждые 15 с
  });
}

// ─── Alarm: опрос загрузок ────────────────────────────────
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === POLL_ALARM) pollPendingDownloads();
});

async function pollPendingDownloads() {
  const { pendingGids = {} } = await localGet('pendingGids');
  if (!Object.keys(pendingGids).length) return;

  const cfg = await getConfig();
  if (!cfg.serverUrl || !cfg.token) return;

  let changed = false;
  try {
    const res = await fetchExt(cfg, '/api/downloads-ext');
    if (!res.ok) return;
    const list = await res.json();

    // Индекс по GID
    const byGid = {};
    list.forEach(d => byGid[d.gid] = d);

    // Индекс по имени файла (для восстановления пропавших GID)
    const byName = {};
    list.forEach(d => { if (d.name) byName[d.name] = d; });

    for (const [gid, info] of Object.entries(pendingGids)) {
      const d = byGid[gid];

      if (!d) {
        // GID пропал из aria2 — файл либо готов, либо удалён
        // Проверяем по файлам на VPS чтобы не пропустить
        if (info.status !== 'complete' && info.status !== 'error') {
          // Считаем завершённым — запрашиваем файлы
          const filesRes = await fetchExt(cfg, '/api/files-ext').catch(() => null);
          if (filesRes && filesRes.ok) {
            const files = await filesRes.json().catch(() => []);
            // Ищем файл появившийся после старта загрузки
            const match = files.find(f =>
              new Date(f.mtime).getTime() > info.addedAt &&
              (f.name === info.name || (info.origName && f.name.startsWith(info.origName.replace(/\.[^.]+$/, ''))))
            );
            if (match) {
              pendingGids[gid].status = 'complete';
              pendingGids[gid].name = match.name;
              changed = true;
              onComplete(cfg, match.name, match.size, gid);
              continue;
            }
          }
          // Не нашли файл — удаляем из отслеживания
          delete pendingGids[gid];
          changed = true;
        }
        continue;
      }

      const prevStatus = info.status;
      pendingGids[gid].name = d.name || info.name;
      pendingGids[gid].status = d.status;
      pendingGids[gid].progress = d.progress;
      changed = true;

      if (d.status === 'complete' && prevStatus !== 'complete') {
        onComplete(cfg, d.name || info.name, d.size, gid);
      } else if (d.status === 'error' && prevStatus !== 'error') {
        notify(`✕ Ошибка загрузки: ${trunc(d.name || info.name, 40)}`);
      }
    }
  } catch (_) {}

  if (changed) {
    await localSet({ pendingGids });
    const activeCount = Object.values(pendingGids).filter(g =>
      g.status === 'active' || g.status === 'waiting' || g.status === 'paused'
    ).length;
    updateBadge(activeCount);
  }
}

async function onComplete(cfg, name, size, gid) {
  const { autoDownload = true } = await localGet('autoDownload');
  const dlUrl = cfg.serverUrl + '/api/ext-dl/' + encodeURIComponent(name) + '?t=' + encodeURIComponent(cfg.token);

  // Сохраняем в список "готово к скачиванию"
  const { readyFiles = [] } = await localGet('readyFiles');
  if (!readyFiles.find(f => f.name === name)) {
    readyFiles.unshift({ name, size, dlUrl, readyAt: Date.now() });
    if (readyFiles.length > 20) readyFiles.pop();
    await localSet({ readyFiles });
  }

  let autoDlOk = false;
  if (autoDownload) {
    try {
      await chrome.downloads.download({ url: dlUrl, filename: name, saveAs: false });
      autoDlOk = true;
    } catch (e) {
      autoDlOk = false;
    }
  }

  // Уведомление с кнопкой — показываем всегда
  // Если авто-скачивание не сработало → кнопка обязательна
  const notifId = 'ready-' + gid;
  chrome.notifications.create(notifId, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL(ICON),
    title: autoDlOk ? '✓ Файл скачивается на ПК!' : '✓ Файл готов на VPS!',
    message: trunc(name, 60),
    buttons: [
      { title: '⬇ Скачать на ПК' },
      { title: '📂 Открыть сайт' },
    ],
    requireInteraction: !autoDlOk, // держать видимым если авто не сработало
  });

  // Сохраняем инфо для кнопки уведомления
  const { notifMap = {} } = await localGet('notifMap');
  notifMap[notifId] = { dlUrl, name, serverUrl: cfg.serverUrl };
  await localSet({ notifMap });
}

// Клик по кнопке в уведомлении
chrome.notifications.onButtonClicked.addListener(async (notifId, btnIdx) => {
  const { notifMap = {} } = await localGet('notifMap');
  const info = notifMap[notifId];
  if (!info) return;
  chrome.notifications.clear(notifId);
  if (btnIdx === 0) {
    // Скачать на ПК
    try {
      await chrome.downloads.download({ url: info.dlUrl, filename: info.name, saveAs: false });
    } catch (e) {
      // Если всё равно не работает — открываем вкладку (браузер скачает сам)
      chrome.tabs.create({ url: info.dlUrl });
    }
  } else {
    chrome.tabs.create({ url: info.serverUrl });
  }
  // Убираем из readyFiles
  const { readyFiles = [] } = await localGet('readyFiles');
  await localSet({ readyFiles: readyFiles.filter(f => f.name !== info.name) });
  const { notifMap: nm = {} } = await localGet('notifMap');
  delete nm[notifId];
  await localSet({ notifMap: nm });
});

// Клик по самому уведомлению — открываем popup/сайт
chrome.notifications.onClicked.addListener(async (notifId) => {
  if (!notifId.startsWith('ready-')) return;
  chrome.action.openPopup?.().catch(() => {});
});

// ─── Контекстные меню ─────────────────────────────────────
function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    [
      ['dl-link',      'Скачать ссылку на VPS',           ['link']],
      ['dl-image',     'Скачать изображение на VPS',       ['image']],
      ['dl-video',     'Скачать видео/аудио на VPS',       ['video', 'audio']],
      ['dl-page',      'Скачать эту страницу на VPS',      ['page']],
      ['dl-selection', 'Скачать выделенный URL на VPS',    ['selection']],
    ].forEach(([id, title, contexts]) => chrome.contextMenus.create({ id, title, contexts }));
  });
}

chrome.contextMenus.onClicked.addListener((info) => {
  const urls = { 'dl-link': info.linkUrl, 'dl-image': info.srcUrl, 'dl-video': info.srcUrl, 'dl-page': info.pageUrl, 'dl-selection': (info.selectionText || '').trim() };
  const url = urls[info.menuItemId];
  if (!url) return;
  if (!/^https?:\/\//i.test(url) && !/^magnet:/i.test(url)) { notify('✕ Неподдерживаемая ссылка'); return; }
  sendDownload(url);
});

// ─── Отправка на VPS ──────────────────────────────────────
async function sendDownload(url) {
  const cfg = await getConfig();
  if (!cfg.serverUrl || !cfg.token) { notify('Настройте расширение — кликните на иконку'); return; }
  flashBadge('↑', '#a083d1');
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 10000);
    const res = await fetchExt(cfg, '/api/add-ext', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'url=' + encodeURIComponent(url),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) { flashBadge('!', '#dc2626'); notify('✕ ' + (data.error || 'HTTP ' + res.status)); return; }

    const origName = trunc(decodeURIComponent(url.split('/').pop().split('?')[0]) || 'файл', 60);
    const { pendingGids = {} } = await localGet('pendingGids');
    pendingGids[data.gid] = { gid: data.gid, name: origName, origName, status: 'active', addedAt: Date.now(), progress: 0 };
    await localSet({ pendingGids });
    setupAlarm();

    const { autoDownload = true } = await localGet('autoDownload');
    notify(autoDownload
      ? `↑ Скачивается на VPS...\nКогда готово — начнётся загрузка на ПК`
      : `↑ Добавлено на VPS\nОткройте расширение для скачивания на ПК`
    );
    setTimeout(refreshBadge, 3000);
  } catch (e) {
    flashBadge('!', '#dc2626');
    notify('✕ ' + (e.name === 'AbortError' ? 'Сервер не отвечает (10с)' : e.message));
  }
}

// ─── Утилиты ──────────────────────────────────────────────
function getConfig() {
  return new Promise(r => chrome.storage.sync.get(['serverUrl', 'token'], cfg =>
    r({ serverUrl: (cfg.serverUrl || '').replace(/\/+$/, ''), token: cfg.token || '' })
  ));
}
function localGet(keys) { return new Promise(r => chrome.storage.local.get(keys, r)); }
function localSet(obj)  { return new Promise(r => chrome.storage.local.set(obj, r)); }
function fetchExt(cfg, path, opts = {}) {
  return fetch(cfg.serverUrl + path, { ...opts, headers: { 'Authorization': 'Bearer ' + cfg.token, ...(opts.headers || {}) } });
}
function notify(message) {
  chrome.notifications.create({ type: 'basic', iconUrl: chrome.runtime.getURL(ICON), title: 'Sipliy Folder VPS', message: String(message), priority: 1 });
}
function flashBadge(text, color) { chrome.action.setBadgeBackgroundColor({ color }); chrome.action.setBadgeText({ text }); }
function updateBadge(count) {
  if (count > 0) { chrome.action.setBadgeBackgroundColor({ color: '#6b509a' }); chrome.action.setBadgeText({ text: String(count) }); }
  else chrome.action.setBadgeText({ text: '' });
}
async function refreshBadge() {
  const cfg = await getConfig();
  const { pendingGids = {} } = await localGet('pendingGids');
  const active = Object.values(pendingGids).filter(g => g.status === 'active' || g.status === 'waiting').length;
  if (active > 0) updateBadge(active);
  else if (!cfg.serverUrl || !cfg.token) { chrome.action.setBadgeBackgroundColor({ color: '#dc2626' }); chrome.action.setBadgeText({ text: '!' }); }
  else chrome.action.setBadgeText({ text: '' });
}
function trunc(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
chrome.storage.onChanged.addListener((_, area) => { if (area === 'sync') refreshBadge(); });
