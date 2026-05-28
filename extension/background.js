// Sipliy Folder VPS — background service worker v2.4 (QR + OTA)

const ICON = 'icons/icon-128.png';
const POLL_ALARM = 'poll-vps';
const UPDATE_ALARM = 'check-update';
const CURRENT_EXT_VERSION = chrome.runtime.getManifest().version;

function normalizeUrl(u) {
  u = (u || '').trim().replace(/\/+$/, '');
  if (!u) return u;
  const noScheme = u.replace(/^https?:\/\//i, '');
  // http:// разрешён только для localhost (dev). Всё остальное → https.
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

// ─── Инициализация ────────────────────────────────────────
chrome.runtime.onInstalled.addListener((details) => {
  setupContextMenus();
  setupAlarms();
  refreshBadge();
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  }
  checkForUpdate();
});
chrome.runtime.onStartup.addListener(() => {
  setupContextMenus();
  setupAlarms();
  refreshBadge();
  checkForUpdate();
});

function setupAlarms() {
  chrome.alarms.get(POLL_ALARM,   a => { if (!a) chrome.alarms.create(POLL_ALARM,   { periodInMinutes: 0.25 }); });
  chrome.alarms.get(UPDATE_ALARM, a => { if (!a) chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 360  }); }); // 6 ч
}

// ─── Alarm: опрос загрузок + синхронизация файлов ─────────
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === POLL_ALARM) {
    // Последовательно: сначала pendingGids (через onComplete) — иначе syncVpsFiles увидит готовый файл первым и скачает дубль.
    await pollPendingDownloads().catch(() => {});
    await syncVpsFiles().catch(() => {});
  }
  if (alarm.name === UPDATE_ALARM) await checkForUpdate().catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'add-url-download') {
    sendDownload(msg.url, { filename: msg.filename || '', forceAutoDownload: true })
      .then(data => sendResponse({ ok: true, ...(data || {}) }))
      .catch(e => sendResponse({ ok: false, error: e.message || 'Ошибка' }));
    return true;
  }
  if (msg.type === 'capture-next-download') {
    startDownloadCapture(msg.timeoutMs || 90000, msg.mode || 'direct')
      .then(data => sendResponse({ ok: true, ...(data || {}) }))
      .catch(e => sendResponse({ ok: false, error: e.message || 'Ошибка' }));
    return true;
  }
  if (msg.type === 'cancel-download-capture') {
    stopDownloadCapture('cancelled').then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'get-download-capture') {
    getCaptureState().then(data => sendResponse({ ok: true, capture: data.captureNext || null }));
    return true;
  }
});

// ─── Получение всех аккаунтов ─────────────────────────────
function getAllAccounts() {
  return new Promise(r => {
    chrome.storage.sync.get(['accounts', 'activeAccountId', 'siteUrl', 'serverUrl', 'token'], d => {
      let accounts = Array.isArray(d.accounts) ? d.accounts : [];
      let siteUrl = normalizeUrl(d.siteUrl || d.serverUrl || accounts.find(a => a.url)?.url || '');
      // Migration: old single-account format
      if (!accounts.length && d.serverUrl && d.token) {
        siteUrl = normalizeUrl(d.serverUrl);
        r([{ id: 'legacy', name: 'Мой аккаунт', url: siteUrl, token: d.token }]);
        return;
      }
      r(accounts.map(a => ({ ...a, url: normalizeUrl(siteUrl || a.url) })));
    });
  });
}

function getConfig() {
  return new Promise(r => {
    chrome.storage.sync.get(['accounts', 'activeAccountId', 'siteUrl', 'serverUrl', 'token'], d => {
      const accounts = Array.isArray(d.accounts) ? d.accounts : [];
      const siteUrl = normalizeUrl(d.siteUrl || d.serverUrl || accounts.find(a => a.url)?.url || '');
      if (!accounts.length && d.serverUrl && d.token) {
        r({ serverUrl: normalizeUrl(d.serverUrl), token: d.token, accountId: 'legacy' });
        return;
      }
      const acc = accounts.find(a => a.id === d.activeAccountId) || accounts[0] || null;
      if (!acc) r({ serverUrl: '', token: '', accountId: null });
      else r({ serverUrl: siteUrl, token: acc.token, accountId: acc.id });
    });
  });
}

async function getCaptureState() {
  return await localGet('captureNext');
}

async function startDownloadCapture(timeoutMs, mode = 'direct') {
  const cfg = await getConfig();
  if (!cfg.serverUrl || !cfg.token) throw new Error('Настройте аккаунт');
  const captureNext = {
    active: true,
    accountId: cfg.accountId,
    serverUrl: cfg.serverUrl,
    mode: mode === 'relay' ? 'relay' : 'direct',
    startedAt: Date.now(),
    expiresAt: Date.now() + Math.max(15000, Math.min(timeoutMs || 90000, 180000)),
  };
  await localSet({ captureNext });
  flashBadge('⏺', '#a083d1');
  notify((captureNext.mode === 'relay' ? '⏺ Браузерный перехват включён' : '⏺ Перехват включён') + '\nТеперь нажмите настоящую кнопку Download на странице');
  return { captureNext };
}

async function stopDownloadCapture(reason) {
  const { captureNext = null } = await localGet('captureNext');
  if (captureNext) {
    captureNext.active = false;
    captureNext.reason = reason || 'stopped';
    captureNext.stoppedAt = Date.now();
    await localSet({ captureNext });
  }
  refreshBadge();
}

function getDownloadFilename(item, url) {
  const raw = item.filename || item.suggestedFilename || '';
  const fromPath = raw.split(/[\\/]/).filter(Boolean).pop();
  if (fromPath) return fromPath;
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
  } catch {
    return '';
  }
}

async function buildCapturedHeaders(item, url) {
  const headers = [];
  const ref = item.referrer || item.referrerUrl || '';
  if (ref) headers.push({ name: 'Referer', value: ref });
  const ua = (self.navigator && self.navigator.userAgent) || 'Mozilla/5.0';
  if (ua) headers.push({ name: 'User-Agent', value: ua });
  try {
    const cookies = await new Promise(resolve => chrome.cookies.getAll({ url }, resolve));
    const cookieHeader = (cookies || []).map(c => c.name + '=' + c.value).join('; ');
    if (cookieHeader) headers.push({ name: 'Cookie', value: cookieHeader });
  } catch {}
  return headers;
}

async function relayUploadToVps(url, opts = {}) {
  const cfg = await getConfig();
  if (!cfg.serverUrl || !cfg.token) throw new Error('Настройте аккаунт');
  flashBadge('⇅', '#a083d1');
  
  const headers = {};
  if (opts.headers) {
    opts.headers.forEach(h => { headers[h.name] = h.value; });
  }

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error('Browser fetch HTTP ' + res.status);
  const blob = await res.blob();
  let name = opts.filename || '';
  const cd = res.headers.get('content-disposition') || '';
  const m = cd.match(/filename\*=UTF-8''([^;]+)|filename="?([^"]+)"?/i);
  if (!name && m) name = decodeURIComponent(m[1] || m[2] || '');
  if (!name) name = getDownloadFilename({}, url) || 'download.bin';
  const fd = new FormData();
  fd.append('file', blob, name);
  const up = await fetch(cfg.serverUrl + '/api/upload-ext', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + cfg.token },
    body: fd,
  });
  const data = await up.json().catch(() => ({}));
  if (!up.ok || data.error) throw new Error(data.error || ('Upload HTTP ' + up.status));
  notify('✓ Файл загружен на VPS через браузер\n' + (data.name || name));
  await syncVpsFiles();
  return data;
}

async function handleCapturedDownloadItem(item) {
  const { captureNext = null } = await localGet('captureNext');
  if (!captureNext || !captureNext.active) return false;
  if (captureNext.handlingDownloadId === item.id) return true;
  if (Date.now() > captureNext.expiresAt) { await stopDownloadCapture('expired'); return true; }

  const url = item.finalUrl || item.url || '';
  if (!/^https?:\/\//i.test(url)) return false;
  if (captureNext.serverUrl && url.includes(captureNext.serverUrl + '/api/ext-dl/')) return false;

  captureNext.handlingDownloadId = item.id;
  await localSet({ captureNext });

  try {
    await chrome.downloads.cancel(item.id).catch(() => {});
    await chrome.downloads.erase({ id: item.id }).catch(() => {});
    await stopDownloadCapture('captured');

    const filename = getDownloadFilename(item, url);
    const headers = await buildCapturedHeaders(item, url);

    if (captureNext.mode === 'relay') {
      notify('Загрузка перехвачена\nПередаю файл через браузер на VPS...');
      relayUploadToVps(url, { filename, headers }).catch(e => notify('Ошибка relay-загрузки: ' + e.message));
    } else {
      notify('Загрузка перехвачена\nОтправляю ссылку на VPS...');
      sendDownload(url, { filename, headers, forceAutoDownload: true }).catch(e => notify('Ошибка загрузки на VPS: ' + e.message));
    }
    return true;
  } catch (e) {
    await stopDownloadCapture('error');
    notify('Не удалось обработать перехваченную загрузку: ' + (e.message || 'Ошибка'));
    return true;
  }
}

chrome.downloads.onCreated.addListener(async (item) => {
  const handled = await handleCapturedDownloadItem(item);
  if (!handled) {
    const { captureNext = null } = await localGet('captureNext');
    if (captureNext && captureNext.active) {
      captureNext.pendingDownloadId = item.id;
      await localSet({ captureNext });
    }
  }
});

chrome.downloads.onChanged.addListener(async (delta) => {
  const { captureNext = null } = await localGet('captureNext');
  if (!captureNext || !captureNext.active) return;
  if (captureNext.pendingDownloadId && captureNext.pendingDownloadId !== delta.id) return;
  if (!delta.url && !delta.finalUrl && !delta.filename && !delta.state) return;
  const items = await chrome.downloads.search({ id: delta.id }).catch(() => []);
  if (items && items[0]) await handleCapturedDownloadItem(items[0]);
});

// ─── Backoff при недоступном VPS ──────────────────────────
async function getBackoff(accId) {
  const { vpsBackoff = {} } = await localGet('vpsBackoff');
  return vpsBackoff[accId] || { failures: 0, skipUntil: 0 };
}
async function recordBackoff(accId, ok) {
  const { vpsBackoff = {} } = await localGet('vpsBackoff');
  if (ok) {
    if (!vpsBackoff[accId] || vpsBackoff[accId].failures === 0) return;
    vpsBackoff[accId] = { failures: 0, skipUntil: 0 };
  } else {
    const failures = (vpsBackoff[accId]?.failures || 0) + 1;
    // 2^N × 15с, потолок 8 минут
    const skipMs = Math.min(Math.pow(2, Math.min(failures, 5)) * 15000, 480000);
    vpsBackoff[accId] = { failures, skipUntil: Date.now() + skipMs };
  }
  await localSet({ vpsBackoff });
}

async function syncVpsFiles() {
  const accounts = await getAllAccounts();
  for (const acc of accounts) {
    await syncVpsFilesForAccount(acc).catch(() => {});
  }
}

async function syncVpsFilesForAccount(acc) {
  if (!acc.url || !acc.token) return;
  const bo = await getBackoff(acc.id);
  if (Date.now() < bo.skipUntil) return;
  const cfg = { serverUrl: acc.url, token: acc.token };

  let res;
  try { res = await fetchExt(cfg, '/api/files-ext'); }
  catch (_) { await recordBackoff(acc.id, false); return; }
  if (!res.ok) { await recordBackoff(acc.id, false); return; }
  await recordBackoff(acc.id, true);
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
  // Дедуп с pendingGids: эти файлы обработает onComplete — не дублируем download.
  const { pendingGids = {} } = await localGet('pendingGids');
  const pendingNames = new Set(
    Object.values(pendingGids)
      .filter(p => p.accountId === acc.id)
      .map(p => p.name)
  );
  const newFiles = files.filter(f => !knownSet.has(f.name) && f.source !== 'upload' && !pendingNames.has(f.name));

  if (newFiles.length > 0) {
    const { readyFiles = [] } = await localGet('readyFiles');
    const { autoDownload = true } = await localGet('autoDownload');
    const readyKeys = new Set(readyFiles.map(r => r.name + '|' + (r.accountId || '')));

    for (const f of newFiles) {
      const key = f.name + '|' + acc.id;
      if (readyKeys.has(key)) continue; // уже есть
      readyFiles.unshift({ name: f.name, size: f.size, readyAt: Date.now(), fromSite: true, accountId: acc.id });
      if (readyFiles.length > 50) readyFiles.pop();

      let autoDlOk = false;
      if (autoDownload) {
        try {
          const dlUrl = await getTicketUrl(cfg, f.name);
          await chrome.downloads.download({ url: dlUrl, filename: safeFilename(f.name), saveAs: false });
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
      notifMap[notifId] = { name: f.name, serverUrl: acc.url, accountId: acc.id };
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
    const bo = await getBackoff(acc.id);
    if (Date.now() < bo.skipUntil) continue;
    const cfg = { serverUrl: acc.url, token: acc.token, accountId: acc.id };

    try {
      const res = await fetchExt(cfg, '/api/downloads-ext');
      if (!res.ok) { await recordBackoff(acc.id, false); continue; }
      await recordBackoff(acc.id, true);
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
                onComplete(cfg, match.name, match.size, gid, pendingGids[gid]);
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
          onComplete(cfg, d.name || info.name, d.size, gid, pendingGids[gid]);
        } else if (d.status === 'error' && prevStatus !== 'error') {
          notify(`✕ Ошибка загрузки: ${trunc(d.name || info.name, 40)}`);
        }
      }
    } catch (_) { await recordBackoff(acc.id, false); }
  }

  if (changed) {
    await localSet({ pendingGids });
    const activeCount = Object.values(pendingGids).filter(g =>
      g.status === 'active' || g.status === 'waiting' || g.status === 'paused'
    ).length;
    updateBadge(activeCount);
  }
}

async function onComplete(cfg, name, size, gid, info = {}) {
  const { autoDownload = true } = await localGet('autoDownload');
  const shouldAutoDownload = info.forceAutoDownload || autoDownload;

  const { readyFiles = [] } = await localGet('readyFiles');
  const exists = readyFiles.find(f => f.name === name && (!f.accountId || f.accountId === cfg.accountId));
  if (!exists) {
    readyFiles.unshift({ name, size, readyAt: Date.now(), accountId: cfg.accountId });
    if (readyFiles.length > 50) readyFiles.pop();
    await localSet({ readyFiles });
  }

  let autoDlOk = false;
  if (shouldAutoDownload) {
    try {
      const dlUrl = await getTicketUrl(cfg, name);
      await chrome.downloads.download({ url: dlUrl, filename: safeFilename(name), saveAs: false });
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
  notifMap[notifId] = { name, serverUrl: cfg.serverUrl, accountId: cfg.accountId };
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
      const accounts = await getAllAccounts();
      const acc = accounts.find(a => a.id === info.accountId) || accounts[0];
      if (!acc) throw new Error('No account');
      const cfg = { serverUrl: acc.url, token: acc.token };
      const dlUrl = await getTicketUrl(cfg, info.name);
      await chrome.downloads.download({ url: dlUrl, filename: safeFilename(info.name), saveAs: false });
    } catch (e) {
      if (info.serverUrl) chrome.tabs.create({ url: info.serverUrl });
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
  // Chrome ≥127: открыть попап. На Edge/старых Chrome — открыть сайт как fallback.
  try {
    if (typeof chrome.action.openPopup === 'function') {
      await chrome.action.openPopup();
      return;
    }
  } catch (_) {}
  const { notifMap = {} } = await localGet('notifMap');
  const info = notifMap[notifId];
  if (info && info.serverUrl) chrome.tabs.create({ url: info.serverUrl });
});

// ─── Контекстные меню ─────────────────────────────────────
function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    [
      ['dl-link',      'Скачать ссылку на VPS',           ['link']],
      ['dl-image',     'Скачать изображение на VPS',       ['image']],
      ['dl-video',     'Скачать видео/аудио на VPS',       ['video', 'audio']],
      ['dl-page',      'Скачать эту страницу на VPS',      ['page']],
      ['capture-next',  'Перехватить следующую загрузку на VPS', ['page']],
      ['capture-relay', 'Перехватить и загрузить браузером на VPS', ['page']],
      ['dl-selection', 'Скачать выделенный URL на VPS',    ['selection']],
    ].forEach(([id, title, contexts]) => chrome.contextMenus.create({ id, title, contexts }));
  });
}

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'capture-next' || info.menuItemId === 'capture-relay') {
    startDownloadCapture(90000, info.menuItemId === 'capture-relay' ? 'relay' : 'direct').catch(e => notify('✕ ' + (e.message || 'Ошибка')));
    return;
  }
  const urls = { 'dl-link': info.linkUrl, 'dl-image': info.srcUrl, 'dl-video': info.srcUrl, 'dl-page': info.pageUrl, 'dl-selection': (info.selectionText || '').trim() };
  const url = urls[info.menuItemId];
  if (!url) return;
  if (!/^https?:\/\//i.test(url) && !/^magnet:/i.test(url)) { notify('✕ Неподдерживаемая ссылка'); return; }
  sendDownload(url).catch(() => {});
});

// ─── Отправка на VPS (активный аккаунт) ──────────────────
async function sendDownload(url, opts = {}) {
  const cfg = await getConfig();
  if (!cfg.serverUrl || !cfg.token) { notify('Настройте расширение — кликните на иконку'); return; }
  flashBadge('↑', '#a083d1');
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 10000);
    const res = await fetchExt(cfg, '/api/add-ext', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'url=' + encodeURIComponent(url)
        + (opts.filename ? '&filename=' + encodeURIComponent(opts.filename) : '')
        + (opts.headers ? '&headers=' + encodeURIComponent(JSON.stringify(opts.headers)) : ''),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      flashBadge('!', '#dc2626');
      const msg = data.error || 'HTTP ' + res.status;
      notify('✕ ' + msg);
      throw new Error(msg);
    }

    const origName = trunc(opts.filename || decodeURIComponent(url.split('/').pop().split('?')[0]) || 'файл', 60);
    const { pendingGids = {} } = await localGet('pendingGids');
    pendingGids[data.gid] = { gid: data.gid, name: origName, origName, status: 'active', addedAt: Date.now(), progress: 0, accountId: cfg.accountId, forceAutoDownload: !!opts.forceAutoDownload };
    await localSet({ pendingGids });
    setupAlarms();

    const { autoDownload = true } = await localGet('autoDownload');
    notify(autoDownload
      ? `↑ Скачивается на VPS...\nКогда готово — начнётся загрузка на ПК`
      : `↑ Добавлено на VPS\nОткройте расширение для скачивания на ПК`
    );
    refreshBadge();
    return { gid: data.gid, name: origName };
  } catch (e) {
    flashBadge('!', '#dc2626');
    notify('✕ ' + (e.name === 'AbortError' ? 'Сервер не отвечает (10с)' : e.message));
    throw e;
  }
}

// ─── Утилиты ──────────────────────────────────────────────
function localGet(keys) { return new Promise(r => chrome.storage.local.get(keys, r)); }
function localSet(obj)  { return new Promise(r => chrome.storage.local.set(obj, r)); }
function fetchExt(cfg, path, opts = {}) {
  return fetch(cfg.serverUrl + path, { ...opts, headers: { 'Authorization': 'Bearer ' + cfg.token, ...(opts.headers || {}) } });
}
// Одноразовый ticket-URL для chrome.downloads (вместо постоянного ?t=bearer в query).
async function getTicketUrl(cfg, fileName) {
  const res = await fetchExt(cfg, '/api/ext-ticket', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'file=' + encodeURIComponent(fileName),
  });
  if (!res.ok) throw new Error('ticket HTTP ' + res.status);
  const d = await res.json().catch(() => ({}));
  if (!d.url) throw new Error('ticket missing url');
  return cfg.serverUrl + d.url;
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

// ─── OTA: проверка версии ──────────────────────────────────
function versionNewer(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i]||0) < (pb[i]||0)) return true;
    if ((pa[i]||0) > (pb[i]||0)) return false;
  }
  return false;
}

async function checkForUpdate() {
  try {
    const { siteUrl, serverUrl } = await new Promise(r =>
      chrome.storage.sync.get(['siteUrl', 'serverUrl'], r)
    );
    const base = (siteUrl || serverUrl || '').replace(/\/+$/, '');
    if (!base) return;
    const resp = await fetch(base + '/api/ext/version');
    if (!resp.ok) return;
    const d = await resp.json();
    if (versionNewer(CURRENT_EXT_VERSION, d.version)) {
      // Store update info
      await new Promise(r => chrome.storage.local.set({ pendingUpdate: d }, r));
      // Show badge "!" in orange
      chrome.action.setBadgeBackgroundColor({ color: '#d97706' });
      chrome.action.setBadgeText({ text: '↑' });
      // Notify once per version
      const key = 'notifiedUpdate_' + d.version;
      const prev = await new Promise(r => chrome.storage.local.get(key, r));
      if (!prev[key]) {
        notify(`Доступна новая версия v${d.version}. Откройте расширение для обновления.`);
        await new Promise(r => chrome.storage.local.set({ [key]: true }, r));
      }
    } else {
      await new Promise(r => chrome.storage.local.remove('pendingUpdate', r));
    }
  } catch { /* ignore */ }
}
