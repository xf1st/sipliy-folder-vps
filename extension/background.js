// Sipliy Folder VPS — background service worker v2.3

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

// ─── Alarm: опрос загрузок + синхронизация файлов ─────────
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === POLL_ALARM) {
    pollPendingDownloads();
    syncVpsFiles(); // следим за файлами добавленными через сайт
  }
});

// ─── Синхронизация файлов VPS (для файлов загруженных через сайт) ──
async function syncVpsFiles() {
  const cfg = await getConfig();
  if (!cfg.serverUrl || !cfg.token) return;

  try {
    const res = await fetchExt(cfg, '/api/files-ext');
    if (!res.ok) return;
    const files = await res.json().catch(() => []);
    const fileNames = files.map(f => f.name);

    const { lastVpsFileNames = null } = await localGet('lastVpsFileNames');

    if (lastVpsFileNames === null) {
      // Первый запуск: сохраняем текущие файлы как baseline, не уведомляем
      await localSet({ lastVpsFileNames: fileNames });
      return;
    }

    const knownSet = new Set(lastVpsFileNames);

    // Новые файлы — появились с момента последней проверки
    const newFiles = files.filter(f => !knownSet.has(f.name));

    if (newFiles.length > 0) {
      const { readyFiles = [] } = await localGet('readyFiles');
      const { autoDownload = true } = await localGet('autoDownload');
      const readyNames = new Set(readyFiles.map(r => r.name));

      for (const f of newFiles) {
        if (readyNames.has(f.name)) continue; // уже в списке (tracked через extension)
        const dlUrl = cfg.serverUrl + '/api/ext-dl/' + encodeURIComponent(f.name) + '?t=' + encodeURIComponent(cfg.token);
        readyFiles.unshift({ name: f.name, size: f.size, dlUrl, readyAt: Date.now(), fromSite: true });
        if (readyFiles.length > 20) readyFiles.pop();

        // Авто-скачивание
        let autoDlOk = false;
        if (autoDownload) {
          try {
            await chrome.downloads.download({ url: dlUrl, filename: f.name, saveAs: false });
            autoDlOk = true;
          } catch (_) {}
        }

        // Уведомление о новом файле с сайта
        const notifId = 'site-' + Date.now() + '-' + encodeURIComponent(f.name).slice(0, 20);
        chrome.notifications.create(notifId, {
          type: 'basic',
          iconUrl: chrome.runtime.getURL(ICON),
          title: autoDlOk ? '✓ Файл скачивается на ПК!' : '✓ Новый файл на VPS!',
          message: trunc(f.name, 60),
          buttons: [{ title: '⬇ Скачать на ПК' }, { title: '📂 Открыть сайт' }],
          requireInteraction: !autoDlOk,
        });
        const { notifMap = {} } = await localGet('notifMap');
        notifMap[notifId] = { dlUrl, name: f.name, serverUrl: cfg.serverUrl };
        await localSet({ notifMap });
      }
      await localSet({ readyFiles });
    }

    // Чистим readyFiles: удаляем файлы которых больше нет на VPS
    const { readyFiles: currentReady = [] } = await localGet('readyFiles');
    const vpsSet = new Set(fileNames);
    const cleanedReady = currentReady.filter(f => vpsSet.has(f.name));
    if (cleanedReady.length !== currentReady.length) {
      await localSet({ readyFiles: cleanedReady });
    }

    // Обновляем baseline
    await localSet({ lastVpsFileNames: fileNames });

  } catch (_) {}
}

// ─── Опрос загрузок (отслеживаемых расширением) ──────────
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

    const byGid  = {};
    const byName = {};
    list.forEach(d => { byGid[d.gid] = d; if (d.name) byName[d.name] = d; });

    for (const [gid, info] of Object.entries(pendingGids)) {
      const d = byGid[gid];

      if (!d) {
        if (info.status !== 'complete' && info.status !== 'error') {
          const filesRes = await fetchExt(cfg, '/api/files-ext').catch(() => null);
          if (filesRes && filesRes.ok) {
            const files = await filesRes.json().catch(() => []);
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
          delete pendingGids[gid];
          changed = true;
        }
        continue;
      }

      const prevStatus = info.status;
      pendingGids[gid].name     = d.name || info.name;
      pendingGids[gid].status   = d.status;
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
    } catch (e) { autoDlOk = false; }
  }

  const notifId = 'ready-' + gid;
  chrome.notifications.create(notifId, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL(ICON),
    title: autoDlOk ? '✓ Файл скачивается на ПК!' : '✓ Файл готов на VPS!',
    message: trunc(name, 60),
    buttons: [{ title: '⬇ Скачать на ПК' }, { title: '📂 Открыть сайт' }],
    requireInteraction: !autoDlOk,
  });

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
    try {
      await chrome.downloads.download({ url: info.dlUrl, filename: info.name, saveAs: false });
    } catch (e) {
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

chrome.notifications.onClicked.addListener(async (notifId) => {
  if (!notifId.startsWith('ready-') && !notifId.startsWith('site-')) return;
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
