const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Config
  loadConfig: ()         => ipcRenderer.invoke('config:load'),
  saveConfig: (cfg)      => ipcRenderer.invoke('config:save', cfg),

  // Dialogs
  pickFolder: ()         => ipcRenderer.invoke('dialog:folder'),
  openFolder: (p)        => ipcRenderer.invoke('shell:open-folder', p),

  // Window controls
  minimize:  ()          => ipcRenderer.send('window:minimize'),
  maximize:  ()          => ipcRenderer.send('window:maximize'),
  close:     ()          => ipcRenderer.send('window:close'),

  // Tray events → renderer
  onTraySync: (cb)       => ipcRenderer.on('tray:sync-all', cb),
});
