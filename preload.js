'use strict';

// The only bridge between the sandboxed pages and the main process.
const { contextBridge, ipcRenderer } = require('electron');

const on = (ch) => (cb) => ipcRenderer.on(ch, (_e, v) => cb(v));

contextBridge.exposeInMainWorld('clawd', {
  // pet
  onState: on('pet-state'),
  onWalk: on('walk'),
  onEvent: on('pet-event'),
  setInteractive: (v) => ipcRenderer.send('set-interactive', !!v),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragEnd: () => ipcRenderer.send('drag-end'),
  menu: () => ipcRenderer.send('menu'),
  // panel
  onPanel: on('panel-state'),
  refresh: () => ipcRenderer.send('refresh'),
  panelHeight: (h) => ipcRenderer.send('panel-height', Number(h)),
  closePanel: () => ipcRenderer.send('panel-close'),
  // settings
  onSettings: on('settings-state'),
  setColor: (hex) => ipcRenderer.send('set-color', hex === null ? null : String(hex)),
});
