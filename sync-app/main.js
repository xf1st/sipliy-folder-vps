const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let tray = null;
const isDev = process.argv.includes('--dev');

// ─── Store (простой JSON-файл для настроек) ───────────────────────────────
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {}
  return {
    serverUrl: 'http://77.73.135.98:3000',
    username: '',
    password: '',
    syncPairs: [],
    minimizeToTray: true,
    startWithWindows: false,
  };
}

function saveConfig(config) {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); } catch {}
}

// ─── Окно ──────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 900,
    minHeight: 580,
    frame: false,           // кастомный тайтлбар
    backgroundColor: '#131313',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    // icon.ico — опционально; если нет, Electron использует дефолтный
    ...(fs.existsSync(path.join(__dirname, 'assets', 'icon.ico'))
      ? { icon: path.join(__dirname, 'assets', 'icon.ico') }
      : fs.existsSync(path.join(__dirname, 'assets', 'icon.png'))
        ? { icon: path.join(__dirname, 'assets', 'icon.png') }
        : {}),
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => mainWindow.show());

  if (isDev) mainWindow.webContents.openDevTools();

  mainWindow.on('close', (e) => {
    const cfg = loadConfig();
    if (cfg.minimizeToTray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// ─── Tray ──────────────────────────────────────────────────────────────────
function createTray() {
  // Используем пустую иконку если файл не найден
  // Пробуем найти иконку для трея (svg → png → ico → пустая)
  const tryPaths = ['tray.png', 'icon.png', 'icon.ico', 'icon.svg'];
  let img = nativeImage.createEmpty();
  for (const f of tryPaths) {
    const p = path.join(__dirname, 'assets', f);
    if (fs.existsSync(p)) { img = nativeImage.createFromPath(p); break; }
  }
  tray = new Tray(img);
  tray.setToolTip('VPS Sync Manager');

  const menu = Menu.buildFromTemplate([
    { label: 'Открыть', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: 'separator' },
    { label: 'Синхронизировать всё', click: () => mainWindow.webContents.send('tray:sync-all') },
    { type: 'separator' },
    { label: 'Выйти', click: () => { app.isQuiting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });
}

// ─── IPC Handlers ──────────────────────────────────────────────────────────
ipcMain.handle('config:load', () => loadConfig());
ipcMain.handle('config:save', (_, config) => { saveConfig(config); return true; });

ipcMain.handle('dialog:folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Выберите папку для синхронизации',
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('shell:open-folder', (_, folderPath) => {
  shell.openPath(folderPath);
});

// Кастомный тайтлбар — управление окном
ipcMain.on('window:minimize', () => mainWindow.minimize());
ipcMain.on('window:maximize', () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('window:close', () => mainWindow.close());

// ─── App lifecycle ─────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
  createTray();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => { app.isQuiting = true; });
