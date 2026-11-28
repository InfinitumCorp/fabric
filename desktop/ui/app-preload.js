// The bridge between the relay's page and the desktop shell: the app's own settings (start at
// login, tray, hotkey, spellcheck) and tray commands. Nothing here can load another page or reach
// the file system; the main process checks every call comes from the relay's page.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('FabricDesktop', {
  version: (process.argv.find((a) => a.startsWith('--fabric-version=')) || '').slice('--fabric-version='.length),
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke('desk:get'),
  setSetting: (key, value) => ipcRenderer.invoke('desk:set', String(key), value),
  spellLanguages: () => ipcRenderer.invoke('desk:spell-langs'),
  onCommand: (fn) => { ipcRenderer.on('desk:command', (_e, c) => { if (typeof c === 'string') fn(c); }); },
});
