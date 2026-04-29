// Sipliy Folder VPS — background service worker v2.3 (multi-account)

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
    syncVpsFiles();
  }
});

// ─── Получение всех аккаунтов ─────────────────────────────
function getAllAccounts() {
  return new Promise(r => {
    chrome.storage.sync.get(['accounts', 'activeAccountId', 'serverUrl', 'token'], d => {
      const accounts = Array.isArray(d.accounts) ? d.accounts : [];
      // Migration: old single-account format
      if (!accounts.length && d.serverUrl && d.token) {
        r([{ id: 'legacy', name: 'Мой VPS', url: d.serverUrl.replace(/\/+$/, ''), token: d.token }]);
        return;
      }
      r(accounts.map(a => ({ ...a, url: (a.url || '').replace(/\/+$/, '') })));
    });
  });
}

function getConfig() {
  return new Promise(r => {
    chrome.storage.sync.get(['accounts', 'activeAccountId', 'serverUrl', 'token'], d => {
      const accounts = Array.isArray(d.accounts) ? d.accounts : [];
      if (!accounts.length && d.serverUrl && d.token) {
        r({ serverUrl: d.serverUrl.replace(/\/+$/, ''), token: d.token, accountId: 'legacy' });
        return;
      }
      const acc = accounts.find(a => a.id === d.activeAccountId) || accounts[0] || null;
      if (!acc) r({ serverUrl: '', token: '', accountId: null });
      else r({ serverUrl: acc.url.replace(/\/+$/, ''), token: acc.token, accountId: acc.id });
    });
  });
}

// ─── Синхронизация файлов VPS (по всем аккаунтам) ────────
async function syncVpsFiles() {
  const accounts = await getAllAccounts();
  for (const acc of accounts) {
    await syncVpsFilesForAccount(acc).catch(() => {});
  }
}

async function syncVpsFilesForAccount(acc) {
  if (!acc.url || !acc.token) return;
  const cfg = { serverUrl: acc.url, token: acc.token };

  const res = await fetchExt(cfg, '/api/files-ext');
  if (!res.ok) return;
  const files = await res.json().catch(() => []);
  const fileNames = files.map(f => f.name);

  const stateKey = 'lastVpsFiles_' + acc.id;
  const stored = await localGet(stateKey);
  const lastVpsFileNames = stored[stateKey] || null;

  if (lastVpsFileNames === null) {
    // Первый запуск: сохраняем baseline, не уведомляем
    await localSet({ [stateKey]: fileNames });
    return;
  }

  const knownSet = new Set(lastVpsFileNames);
  const newFiles = files.filter(f => !knownSet.has(f.name));

  if (newFiles.length > 0) {
    const { readyFiles = [] } = await localGet('readyFiles');
    const { autoDownload = true } = await localGet('autoDownload');
    const readyKeys = new Set(readyFiles.map(r => r.name + '|' + (r.accountId || '')));

    for (const f of newFiles) {
      const key = f.name + '|' + acc.id;
      if (readyKeys.has(key)) continue; // уже есть
      const dlUrl = acc.url + '/api/ext-dl/' + encodeURIComponent(f.name) + '?t=' + encodeURIComponent(acc.token);
      readyFiles.unshift({ name: f.name, size: f.size, dlUrl, readyAt: Date.now(), fromSite: true, accountId: acc.id });
      if (readyFiles.length > 50) readyFiles.pop();

      let autoDlOk = false;
      if (autoDownload) {
        try {
          await chrome.downloads.download({ url: dlUrl, filename: f.name, saveAs: false });
          autoDlOk = true;
        } catch (_) {}
      }

      const notifId = 'site-' + acc.id.slice(0, 6) + '-' + Date.now() + '-' + encodeURIComponent(f.name).slice(0, 15);
      chrome.notifications.create(notifId, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL(ICON),
        title: autoDlOk ? '✓ Файл скачивается на ПК!' : '✓ Новый файл на VPS!',
        message: trunc(f.name, 60),
        buttons: [{ title: '⬇ Скачать на ПК' }, { title: '📂 Открыть сайт' }],
        requireInteraction: !autoDlOk,
      });
      const { notifMap = {} } = await localGet('notifMap');
      notifMap[notifId] = { dlUrl, name: f.name, serverUrl: acc.url };
      await localSet({ notifMap });
    }
    await localSet({ readyFiles });
  }

  // Чистим readyFiles: удаляем файлы которых больше нет на VPS (только для этого аккаунта)
  const { readyFiles: currentReady = [] } = await localGet('readyFiles');
  const vpsSet = new Set(fileNames);
  const cleanedReady = currentReady.filter(f => {
    const isThisAcc = !f.accountId || f.accountId === acc.id;
    return !isThisAcc || vpsSet.has(f.name);
  });
  if (cleanedReady.length !== currentReady.length) {
    await localSet({ readyFiles: cleanedReady });
  }

  // Обновляем baseline
  await localSet({ [stateKey]: fileNames });
}

// ─── Опрос загрузок (по всем аккаунтам) ──────────────────
async function pollPendingDownloads() {
  const { pendingGids = {} } = await localGet('pendingGids');
  if (!Object.keys(pendingGids).length) return;

  const accounts = await getAllAccounts();
  const accountMap = {};
  accounts.forEach(a => { accountMap[a.id] = a; });

  // Группируем gid-ы по аккаунту
  const byAccount = {};
  for (const [gid, info] of Object.entries(pendingGids)) {
    const aid = info.accountId || accounts[0]?.id || 'legacy';
    if (!byAccount[aid]) byAccount[aid] = [];
    byAccount[aid].push([gid, info]);
  }

  let changed = false;

  for (const [aid, gidEntries] of Object.entries(byAccount)) {
    const acc = accountMap[aid];
    if (!acc) {
      // Аккаунт удалён — чистим его gid-ы
      for (const [gid] of gidEntries) delete pendingGids[gid];
      changed = true;
      continue;
    }
    const cfg = { serverUrl: acc.url, token: acc.token, accountId: acc.id };

    try {
      const res = await fetchExt(cfg, '/api/downloads-ext');
      if (!res.ok) continue;
      const list = await res.json();
      const byGid  = {};
      const byName = {};
      list.forEach(d => { byGid[d.gid] = d; if (d.name) byName[d.name] = d; });

      for (const [gid, info] of gidEntries) {
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
                pendingGids[gid].name   = match.name;
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
  }

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
  const exists = readyFiles.find(f => f.name === name && (!f.accountId || f.accountId === cfg.accountId));
  if (!exists) {
    readyFiles.unshift({ name, size, dlUrl, readyAt: Date.now(), accountId: cfg.accountId });
    if (readyFiles.length > 50) readyFiles.pop();
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

// ─── Клик по кнопке в уведомлении ────────────────────────
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

// ─── Отправка на VPS (активный аккаунт) ──────────────────
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
    pendingGids[data.gid] = { gid: data.gid, name: origName, origName, status: 'active', addedAt: Date.now(), progress: 0, accountId: cfg.accountId };
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
  const { pendingGids = {} } = await localGet('pendingGids');
  const active = Object.values(pendingGids).filter(g => g.status === 'active' || g.status === 'waiting').length;
  if (active > 0) { updateBadge(active); return; }
  const accounts = await getAllAccounts();
  if (!accounts.length) { chrome.action.setBadgeBackgroundColor({ color: '#dc2626' }); chrome.action.setBadgeText({ text: '!' }); }
  else chrome.action.setBadgeText({ text: '' });
}
function trunc(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
chrome.storage.onChanged.addListener((_, area) => { if (area === 'sync') refreshBadge(); });
