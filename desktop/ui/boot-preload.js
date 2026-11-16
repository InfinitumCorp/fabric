const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fabricBoot', {
  onState: (fn) => ipcRenderer.on('boot:state', (_e, state) => fn(state)),
  retry: () => ipcRenderer.send('boot:retry'),
});
