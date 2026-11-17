// Minimal bridge between the buddy UI and the Electron window.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('buddyWindow', {
  collapse: () => ipcRenderer.send('buddy:collapse'),
  expand: () => ipcRenderer.send('buddy:expand'),
  onFocusInput: (cb) => ipcRenderer.on('buddy:focus-input', () => cb()),
});
