const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Config
  loadConfig:   ()    => ipcRenderer.invoke('config:load'),
  saveConfig:   (cfg) => ipcRenderer.invoke('config:save', cfg),
  // Dialogs
  pickFolder:   ()    => ipcRenderer.invoke('dialog:folder'),
  openPath:     (p)   => ipcRenderer.invoke('shell:open', p),
  // Window
  minimize:     ()    => ipcRenderer.send('window:minimize'),
  maximize:     ()    => ipcRenderer.send('window:maximize'),
  close:        ()    => ipcRenderer.send('window:close'),
  // Engine
  connect:      ()            => ipcRenderer.invoke('engine:connect'),
  syncPair:     (id)          => ipcRenderer.invoke('engine:sync-pair', id),
  syncAll:      ()            => ipcRenderer.invoke('engine:sync-all'),
  watchStart:   (id)          => ipcRenderer.invoke('engine:watch-start', id),
  watchStop:    (id)          => ipcRenderer.invoke('engine:watch-stop', id),
  // Events from main → renderer
  onLog:      (cb) => ipcRenderer.on('engine:log',      (_, d) => cb(d)),
  onStatus:   (cb) => ipcRenderer.on('engine:status',   (_, d) => cb(d)),
  onProgress: (cb) => ipcRenderer.on('engine:progress', (_, d) => cb(d)),
  onTraySync: (cb) => ipcRenderer.on('tray:sync-all',   () => cb()),
});
