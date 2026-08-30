'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Bridge for the auto-hiding drag strip. Deliberately tiny: it can resize its
 * own overlay, run the three window buttons, and receive the page title.
 * Nothing else.
 */

const titleListeners = new Set();

ipcRenderer.on('dragbar:title', (_event, title) => {
  for (const fn of titleListeners) {
    try {
      fn(title);
    } catch {
      /* ignore */
    }
  }
});

contextBridge.exposeInMainWorld('dragbar', {
  expand: (value) => ipcRenderer.send('dragbar:expand', Boolean(value)),
  minimize: () => ipcRenderer.send('dragbar:minimize'),
  toggleMaximize: () => ipcRenderer.send('dragbar:toggle-maximize'),
  close: () => ipcRenderer.send('dragbar:close'),
  onTitle: (fn) => {
    if (typeof fn !== 'function') return () => {};
    titleListeners.add(fn);
    return () => titleListeners.delete(fn);
  }
});
