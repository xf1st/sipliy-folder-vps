const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
const SyncEngine = require('./sync-engine');

const isDev = process.argv.includes('--dev');
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

let mainWindow = null;
let tray       = null;
let engine     = null;

// ── Config ────────────────────────────────────────────────────────────────
function loadConfig() {
  try { if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch {}
  return { serverUrl: 'http://77.73.135.98:3000', username: '', password: '', syncPairs: [], minimizeToTray: true };
}
function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); } catch {}
}

// ── Engine ────────────────────────────────────────────────────────────────
function buildEngine(cfg) {
  return new SyncEngine({
    serverUrl: cfg.serverUrl,
    username:  cfg.username,
    password:  cfg.password,
    onLog: (level, msg) => {
      console.log(`[${level}] ${msg}`);
      mainWindow?.webContents.send('engine:log', { level, msg, ts: Date.now() });
    },
    onStatus: (pairId, status) => {
      mainWindow?.webContents.send('engine:status', { pairId, status });
    },
  });
}

// ── Window ────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100, height: 700, minWidth: 900, minHeight: 580,
    frame: false,
    backgroundColor: '#131313',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  if (isDev) mainWindow.webContents.openDevTools();

  mainWindow.on('close', e => {
    if (loadConfig().minimizeToTray) { e.preventDefault(); mainWindow.hide(); }
  });
}

// ── Tray ──────────────────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  const img = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip('VPS Sync Manager');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть',           click: () => { mainWindow.show(); mainWindow.focus(); } },
    { label: 'Синхронизировать',  click: () => mainWindow.webContents.send('tray:sync-all') },
    { type: 'separator' },
    { label: 'Выйти',             click: () => { app.isQuiting = true; app.quit(); } },
  ]));
  tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });
}

// ── IPC ───────────────────────────────────────────────────────────────────
ipcMain.handle('config:load',   () => loadConfig());
ipcMain.handle('config:save',   (_, cfg) => { saveConfig(cfg); engine = null; return true; });
ipcMain.handle('dialog:folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('shell:open', (_, p) => shell.openPath(p));

// Connect & test
ipcMain.handle('engine:connect', async () => {
  const cfg = loadConfig();
  engine = buildEngine(cfg);
  try { await engine.login(); return { ok: true }; }
  catch (e) { engine = null; return { ok: false, error: e.message }; }
});

// Manual full sync for one pair
ipcMain.handle('engine:sync-pair', async (_, pairId) => {
  const cfg = loadConfig();
  if (!engine) engine = buildEngine(cfg);
  const pair = cfg.syncPairs.find((_, i) => i === pairId);
  if (!pair) return { ok: false, error: 'Pair not found' };
  try {
    await engine.ensureAuth();
    const result = await engine.syncPair(pair, (msg, pct) => {
      mainWindow?.webContents.send('engine:progress', { pairId, msg, pct });
    });
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Toggle watch
ipcMain.handle('engine:watch-start', async (_, pairId) => {
  const cfg = loadConfig();
  if (!engine) engine = buildEngine(cfg);
  const pair = cfg.syncPairs[pairId];
  if (!pair) return { ok: false };
  try { await engine.ensureAuth(); } catch (e) { return { ok: false, error: e.message }; }
  engine.startWatch(pairId, pair);
  return { ok: true };
});

ipcMain.handle('engine:watch-stop', (_, pairId) => {
  engine?.stopWatch(pairId);
  return { ok: true };
});

// Sync all pairs
ipcMain.handle('engine:sync-all', async () => {
  const cfg = loadConfig();
  if (!engine) engine = buildEngine(cfg);
  try { await engine.ensureAuth(); } catch (e) { return { ok: false, error: e.message }; }
  const results = [];
  for (let i = 0; i < cfg.syncPairs.length; i++) {
    try {
      const r = await engine.syncPair(cfg.syncPairs[i], (msg, pct) =>
        mainWindow?.webContents.send('engine:progress', { pairId: i, msg, pct }));
      results.push({ pairId: i, ok: true, ...r });
    } catch (e) {
      results.push({ pairId: i, ok: false, error: e.message });
    }
  }
  return { ok: true, results };
});

ipcMain.on('window:minimize', () => mainWindow.minimize());
ipcMain.on('window:maximize', () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('window:close',    () => mainWindow.close());

// ── App lifecycle ─────────────────────────────────────────────────────────
app.whenReady().then(() => { createWindow(); createTray(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('before-quit', () => { app.isQuiting = true; engine?.stopAll(); });
