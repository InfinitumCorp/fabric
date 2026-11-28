const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fabricPicker', {
  sources: () => ipcRenderer.invoke('picker:sources'),
  choose: (id) => ipcRenderer.send('picker:choose', id),
});
